// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * Educational project for the course Introduction to Finance.
 * Not a real product, service or investment offer. Do not use with real funds.
 *
 * Parametric crop insurance: if season rainfall is below a threshold,
 * every policyholder is paid automatically. Money = test coin of the LOCAL network.
 * The admin can only grant/revoke roles. It cannot move funds or change results.
 */
contract PolicyPool is AccessControl, ReentrancyGuard {
    bytes32 public constant INSURER_ROLE = keccak256("INSURER_ROLE");
    bytes32 public constant DATA_PROVIDER_ROLE = keccak256("DATA_PROVIDER_ROLE");
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");

    struct TemplateParams {
        string crop;
        string region;
        uint256 thresholdMm;     // pay if rainfall is BELOW this
        uint256 payoutPerPolicy;
        uint256 premium;
        uint256 seasonEnd;       // sales stop, weather readings start
        uint256 toleranceMm;     // max gap between two providers
    }

    struct Template {
        address insurer;
        string crop;
        string region;
        uint256 thresholdMm;
        uint256 payoutPerPolicy;
        uint256 premium;
        uint256 seasonEnd;
        uint256 toleranceMm;
        uint256 pool;
        uint256 premiumsCollected;
        uint256 policyCount;
        uint256 rainfallMm;
        bool weatherRecorded;
        bool disputed;
        bool evaluated;
        bool triggered;
        bool closed;
    }

    struct Reading {
        address firstProvider;
        uint256 firstValue;
        uint8 count;
    }

    uint256 public templateCount;
    mapping(uint256 => Template) private templates;
    mapping(uint256 => Reading) private readings;
    mapping(uint256 => address[]) private holders;
    mapping(uint256 => mapping(address => bool)) public hasPolicy;
    mapping(address => uint256) public pending; // payouts that could not be sent directly

    event TemplateCreated(uint256 indexed id, address indexed insurer, uint256 thresholdMm, uint256 payoutPerPolicy, uint256 premium, uint256 seasonEnd);
    event PoolFunded(uint256 indexed id, uint256 amount, uint256 poolBalance);
    event PolicyBought(uint256 indexed id, address indexed farmer);
    event ReadingSubmitted(uint256 indexed id, address indexed provider, uint256 rainfallMm);
    event WeatherRecorded(uint256 indexed id, uint256 rainfallMm);
    event DisputeOpened(uint256 indexed id, address indexed by);
    event DisputeResolved(uint256 indexed id, uint256 rainfallMm);
    event Evaluated(uint256 indexed id, bool triggered, uint256 paidPolicies, uint256 totalPaid);
    event SeasonClosed(uint256 indexed id, uint256 returnedToInsurer);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address admin) {
        require(admin != address(0), "Admin is zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function _get(uint256 id) internal view returns (Template storage t) {
        t = templates[id];
        require(t.insurer != address(0), "No such template");
    }

    // 1. insurer creates a season template and funds the pool
    function createTemplate(TemplateParams calldata p)
        external
        onlyRole(INSURER_ROLE)
        returns (uint256 id)
    {
        require(p.thresholdMm > 0, "Threshold must be > 0");
        require(p.payoutPerPolicy > 0 && p.premium > 0, "Amounts must be > 0");
        require(p.seasonEnd > block.timestamp, "Season end must be in the future");

        id = ++templateCount;
        Template storage t = templates[id];
        t.insurer = msg.sender;
        t.crop = p.crop;
        t.region = p.region;
        t.thresholdMm = p.thresholdMm;
        t.payoutPerPolicy = p.payoutPerPolicy;
        t.premium = p.premium;
        t.seasonEnd = p.seasonEnd;
        t.toleranceMm = p.toleranceMm;

        emit TemplateCreated(id, msg.sender, p.thresholdMm, p.payoutPerPolicy, p.premium, p.seasonEnd);
    }

    function fundPool(uint256 id) external payable {
        Template storage t = _get(id);
        require(msg.sender == t.insurer, "Only template insurer");
        require(!t.closed, "Season closed");
        require(msg.value > 0, "Nothing sent");
        t.pool += msg.value;
        emit PoolFunded(id, msg.value, t.pool);
    }

    // 2. farmer buys a policy; every policy must be fully backed by the pool
    function buyPolicy(uint256 id) external payable {
        Template storage t = _get(id);
        require(block.timestamp < t.seasonEnd, "Sales closed");
        require(msg.value == t.premium, "Wrong premium");
        require(!hasPolicy[id][msg.sender], "Already insured");
        require(t.pool >= (t.policyCount + 1) * t.payoutPerPolicy, "Pool does not cover policy");

        hasPolicy[id][msg.sender] = true;
        holders[id].push(msg.sender);
        t.policyCount += 1;
        t.premiumsCollected += msg.value;
        emit PolicyBought(id, msg.sender);
    }

    // 3. two different data providers report rainfall after the season
    function submitReading(uint256 id, uint256 rainfallMm) external onlyRole(DATA_PROVIDER_ROLE) {
        Template storage t = _get(id);
        require(block.timestamp >= t.seasonEnd, "Season not ended");
        require(!t.weatherRecorded && !t.disputed, "Readings closed");

        Reading storage r = readings[id];
        require(r.count < 2, "Readings closed");
        emit ReadingSubmitted(id, msg.sender, rainfallMm);

        if (r.count == 0) {
            r.firstProvider = msg.sender;
            r.firstValue = rainfallMm;
            r.count = 1;
            return;
        }

        require(msg.sender != r.firstProvider, "Need a different provider");
        r.count = 2;

        uint256 first = r.firstValue;
        uint256 diff = rainfallMm > first ? rainfallMm - first : first - rainfallMm;
        if (diff <= t.toleranceMm) {
            t.rainfallMm = (rainfallMm + first) / 2;   // average of the two readings
            t.weatherRecorded = true;
            emit WeatherRecorded(id, t.rainfallMm);
        } else {
            t.disputed = true;                          // readings disagree: freeze
            emit DisputeOpened(id, msg.sender);
        }
    }

    // 4. disputes
    function openDispute(uint256 id) external {
        Template storage t = _get(id);
        require(msg.sender == t.insurer || hasRole(REGULATOR_ROLE, msg.sender), "Not allowed");
        require(t.weatherRecorded && !t.evaluated, "Nothing to dispute");
        require(!t.disputed, "Already disputed");
        t.disputed = true;
        emit DisputeOpened(id, msg.sender);
    }

    function resolveDispute(uint256 id, uint256 finalRainfallMm) external onlyRole(REGULATOR_ROLE) {
        Template storage t = _get(id);
        require(t.disputed && !t.evaluated, "No open dispute");
        t.rainfallMm = finalRainfallMm;
        t.weatherRecorded = true;
        t.disputed = false;
        emit DisputeResolved(id, finalRainfallMm);
    }

    // 5. anyone triggers the evaluation; payouts are automatic
    // Security: nonReentrant + state is updated BEFORE money is sent.
    function evaluateAndPay(uint256 id) external nonReentrant {
        Template storage t = _get(id);
        require(!t.disputed, "Payout frozen by dispute");
        require(t.weatherRecorded, "No weather data");
        require(!t.evaluated, "Already evaluated");

        t.evaluated = true;                             // effects first
        bool trigger = t.rainfallMm < t.thresholdMm;
        uint256 n = holders[id].length;
        uint256 total = 0;

        if (trigger) {
            t.triggered = true;
            total = n * t.payoutPerPolicy;
            t.pool -= total;

            uint256 amount = t.payoutPerPolicy;
            for (uint256 i = 0; i < n; i++) {           // interactions last
                address farmer = holders[id][i];
                (bool ok, ) = payable(farmer).call{value: amount}("");
                if (!ok) {
                    pending[farmer] += amount;          // one bad receiver cannot block others
                }
            }
        }
        emit Evaluated(id, trigger, trigger ? n : 0, total);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pending[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // 6. unused pool and premiums go back to the insurer
    function closeSeason(uint256 id) external nonReentrant {
        Template storage t = _get(id);
        require(msg.sender == t.insurer, "Only template insurer");
        require(t.evaluated, "Not evaluated yet");
        require(!t.closed, "Already closed");

        t.closed = true;
        uint256 amount = t.pool + t.premiumsCollected;
        t.pool = 0;
        t.premiumsCollected = 0;

        (bool ok, ) = payable(t.insurer).call{value: amount}("");
        require(ok, "Transfer failed");
        emit SeasonClosed(id, amount);
    }

    // views
    function getTemplate(uint256 id) external view returns (Template memory) {
        return _get(id);
    }

    function holderCount(uint256 id) external view returns (uint256) {
        return holders[id].length;
    }

    function getReadingCount(uint256 id) external view returns (uint8) {
        return readings[id].count;
    }
}