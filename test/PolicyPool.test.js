const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PAYOUT = ethers.parseEther("2");
const PREMIUM = ethers.parseEther("0.1");
const THRESHOLD = 120n; // mm
const TOLERANCE = 10n; // mm

function params(seasonEnd, overrides = {}) {
  return {
    crop: "wheat",
    region: "Akmola",
    thresholdMm: THRESHOLD,
    payoutPerPolicy: PAYOUT,
    premium: PREMIUM,
    seasonEnd,
    toleranceMm: TOLERANCE,
    ...overrides,
  };
}

async function deployFixture() {
  const [admin, insurer, farmer1, farmer2, provider1, provider2, regulator, stranger] =
    await ethers.getSigners();
  const pool = await (await ethers.getContractFactory("PolicyPool")).deploy(admin.address);
  await pool.waitForDeployment();
  await pool.connect(admin).grantRole(await pool.INSURER_ROLE(), insurer.address);
  await pool.connect(admin).grantRole(await pool.DATA_PROVIDER_ROLE(), provider1.address);
  await pool.connect(admin).grantRole(await pool.DATA_PROVIDER_ROLE(), provider2.address);
  await pool.connect(admin).grantRole(await pool.REGULATOR_ROLE(), regulator.address);
  const seasonEnd = (await time.latest()) + 30 * 24 * 3600;
  return { pool, admin, insurer, farmer1, farmer2, provider1, provider2, regulator, stranger, seasonEnd };
}

// template 1 created and funded with 10, two farmers insured
async function insuredFixture() {
  const ctx = await deployFixture();
  const { pool, insurer, farmer1, farmer2, seasonEnd } = ctx;
  await pool.connect(insurer).createTemplate(params(seasonEnd));
  await pool.connect(insurer).fundPool(1, { value: ethers.parseEther("10") });
  await pool.connect(farmer1).buyPolicy(1, { value: PREMIUM });
  await pool.connect(farmer2).buyPolicy(1, { value: PREMIUM });
  return ctx;
}

// season over and both providers have reported (a, b)
async function reported(ctx, a, b) {
  await time.increaseTo(ctx.seasonEnd);
  await ctx.pool.connect(ctx.provider1).submitReading(1, a);
  await ctx.pool.connect(ctx.provider2).submitReading(1, b);
}

describe("PolicyPool", function () {
  // ---- access control
  it("only an insurer can create a template", async function () {
    const { pool, stranger, seasonEnd } = await loadFixture(deployFixture);
    await expect(pool.connect(stranger).createTemplate(params(seasonEnd)))
      .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
  });

  it("only a data provider can submit weather readings", async function () {
    const ctx = await loadFixture(insuredFixture);
    await time.increaseTo(ctx.seasonEnd);
    await expect(ctx.pool.connect(ctx.stranger).submitReading(1, 100))
      .to.be.revertedWithCustomError(ctx.pool, "AccessControlUnauthorizedAccount");
  });

  // ---- policies
  it("a farmer can buy a policy", async function () {
    const { pool, insurer, farmer1, seasonEnd } = await loadFixture(deployFixture);
    await pool.connect(insurer).createTemplate(params(seasonEnd));
    await pool.connect(insurer).fundPool(1, { value: ethers.parseEther("10") });
    await expect(pool.connect(farmer1).buyPolicy(1, { value: PREMIUM }))
      .to.emit(pool, "PolicyBought").withArgs(1, farmer1.address);
    expect(await pool.hasPolicy(1, farmer1.address)).to.equal(true);
    expect(await pool.holderCount(1)).to.equal(1n);
  });

  it("rejects a wrong premium and a second policy for the same farmer", async function () {
    const { pool, farmer1 } = await loadFixture(insuredFixture);
    await expect(pool.connect(farmer1).buyPolicy(1, { value: PREMIUM }))
      .to.be.revertedWith("Already insured");
    const { pool: p2, stranger } = await loadFixture(insuredFixture);
    await expect(p2.connect(stranger).buyPolicy(1, { value: PREMIUM + 1n }))
      .to.be.revertedWith("Wrong premium");
  });

  it("does not sell a policy that the pool cannot pay", async function () {
    const { pool, insurer, farmer1, farmer2, seasonEnd } = await loadFixture(deployFixture);
    await pool.connect(insurer).createTemplate(params(seasonEnd));
    await pool.connect(insurer).fundPool(1, { value: PAYOUT }); // covers exactly one policy
    await pool.connect(farmer1).buyPolicy(1, { value: PREMIUM });
    await expect(pool.connect(farmer2).buyPolicy(1, { value: PREMIUM }))
      .to.be.revertedWith("Pool does not cover policy");
  });

  // ---- weather data
  it("records the average of two readings within the tolerance", async function () {
    const ctx = await loadFixture(insuredFixture);
    await reported(ctx, 100, 106);
    const t = await ctx.pool.getTemplate(1);
    expect(t.weatherRecorded).to.equal(true);
    expect(t.rainfallMm).to.equal(103n);
  });

  it("freezes the payout when readings disagree, until the regulator decides", async function () {
    const ctx = await loadFixture(insuredFixture);
    const { pool, stranger, regulator, farmer1, farmer2 } = ctx;
    await reported(ctx, 80, 130); // gap 50 > tolerance 10
    await expect(pool.connect(stranger).evaluateAndPay(1))
      .to.be.revertedWith("Payout frozen by dispute");
    await pool.connect(regulator).resolveDispute(1, 90);
    await expect(pool.connect(stranger).evaluateAndPay(1))
      .to.changeEtherBalances([farmer1, farmer2], [PAYOUT, PAYOUT]);
  });

  // ---- payouts
  it("pays every policyholder when rainfall is below the threshold", async function () {
    const ctx = await loadFixture(insuredFixture);
    await reported(ctx, 100, 104); // 102 < 120
    await expect(ctx.pool.connect(ctx.stranger).evaluateAndPay(1))
      .to.changeEtherBalances([ctx.farmer1, ctx.farmer2], [PAYOUT, PAYOUT]);
    expect((await ctx.pool.getTemplate(1)).triggered).to.equal(true);
  });

  it("pays nothing when rainfall is above the threshold", async function () {
    const ctx = await loadFixture(insuredFixture);
    await reported(ctx, 150, 154); // 152 >= 120
    await expect(ctx.pool.connect(ctx.stranger).evaluateAndPay(1))
      .to.changeEtherBalances([ctx.farmer1, ctx.farmer2], [0, 0]);
    expect((await ctx.pool.getTemplate(1)).triggered).to.equal(false);
  });

  it("an insurer dispute freezes the payout; the regulator's value then decides", async function () {
    const ctx = await loadFixture(insuredFixture);
    const { pool, insurer, regulator, stranger, farmer1, farmer2 } = ctx;
    await reported(ctx, 100, 104);
    await pool.connect(insurer).openDispute(1);
    await expect(pool.connect(stranger).evaluateAndPay(1))
      .to.be.revertedWith("Payout frozen by dispute");
    await pool.connect(regulator).resolveDispute(1, 130); // above threshold
    await expect(pool.connect(stranger).evaluateAndPay(1))
      .to.changeEtherBalances([farmer1, farmer2], [0, 0]);
  });

  it("cannot pay twice", async function () {
    const ctx = await loadFixture(insuredFixture);
    await reported(ctx, 100, 104);
    await ctx.pool.connect(ctx.stranger).evaluateAndPay(1);
    await expect(ctx.pool.connect(ctx.stranger).evaluateAndPay(1))
      .to.be.revertedWith("Already evaluated");
  });

  // ---- closing the season
  it("returns the unused pool and the premiums to the insurer", async function () {
    const ctx = await loadFixture(insuredFixture);
    const { pool, insurer, stranger } = ctx;
    await reported(ctx, 100, 104);
    await pool.connect(stranger).evaluateAndPay(1); // pays 2 x 2 = 4 from the pool of 10
    await expect(pool.connect(stranger).closeSeason(1)).to.be.revertedWith("Only template insurer");
    // 10 - 4 = 6 unused + 0.2 premiums = 6.2
    await expect(pool.connect(insurer).closeSeason(1))
      .to.changeEtherBalance(insurer, ethers.parseEther("6.2"));
    await expect(pool.connect(insurer).closeSeason(1)).to.be.revertedWith("Already closed");
  });

  // ---- security: reentrancy
  it("blocks a reentrancy attack: the attacker is paid exactly once", async function () {
    const { pool, insurer, farmer2, provider1, provider2, stranger, seasonEnd } =
      await loadFixture(deployFixture);
    await pool.connect(insurer).createTemplate(params(seasonEnd));
    await pool.connect(insurer).fundPool(1, { value: ethers.parseEther("10") });

    const attacker = await (await ethers.getContractFactory("ReentrancyAttacker"))
      .deploy(await pool.getAddress());
    await attacker.waitForDeployment();
    const attackerAddr = await attacker.getAddress();

    await attacker.buy(1, { value: PREMIUM });
    await pool.connect(farmer2).buyPolicy(1, { value: PREMIUM });

    await time.increaseTo(seasonEnd);
    await pool.connect(provider1).submitReading(1, 100);
    await pool.connect(provider2).submitReading(1, 104);

    await pool.connect(stranger).evaluateAndPay(1); // attacker tries to re-enter here
    // the direct payment to the attacker failed and was kept as "pending"
    expect(await pool.pending(attackerAddr)).to.equal(PAYOUT);
    expect(await ethers.provider.getBalance(attackerAddr)).to.equal(0n);

    await attacker.stopAttack();
    await attacker.withdrawFromPool();
    expect(await ethers.provider.getBalance(attackerAddr)).to.equal(PAYOUT); // once, not twice
    await expect(pool.connect(stranger).evaluateAndPay(1)).to.be.revertedWith("Already evaluated");
  });
});