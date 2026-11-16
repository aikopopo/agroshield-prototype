// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PolicyPool} from "../PolicyPool.sol";

/// TEST ONLY: tries to call evaluateAndPay again while it is being paid.
contract ReentrancyAttacker {
    PolicyPool public immutable pool;
    uint256 public targetId;
    bool public attack = true;

    constructor(PolicyPool _pool) {
        pool = _pool;
    }

    function buy(uint256 id) external payable {
        targetId = id;
        pool.buyPolicy{value: msg.value}(id);
    }

    function stopAttack() external {
        attack = false;
    }

    function withdrawFromPool() external {
        pool.withdraw();
    }

    receive() external payable {
        if (attack) {
            pool.evaluateAndPay(targetId); // reentrant call: must fail
        }
    }
}