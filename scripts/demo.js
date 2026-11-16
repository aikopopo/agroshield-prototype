const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const show = (x) => ethers.formatEther(x) + " test ETH";
const send = async (p) => (await p).wait();

async function main() {
  const [admin, insurer, farmer1, farmer2, provider1, provider2] = await ethers.getSigners();
  console.log("=== AgroShield PolicyPool demo (local network, test accounts only) ===\n");

  console.log("1. Deploy the contract");
  const pool = await (await ethers.getContractFactory("PolicyPool")).deploy(admin.address);
  await pool.waitForDeployment();
  console.log("   PolicyPool deployed at", await pool.getAddress());

  console.log("\n2. Admin grants roles (insurer, two data providers)");
  await send(pool.grantRole(await pool.INSURER_ROLE(), insurer.address));
  await send(pool.grantRole(await pool.DATA_PROVIDER_ROLE(), provider1.address));
  await send(pool.grantRole(await pool.DATA_PROVIDER_ROLE(), provider2.address));

  console.log("\n3. Insurer creates a wheat template: pay 2 if rainfall < 120 mm, premium 0.1");
  const seasonEnd = (await time.latest()) + 90 * 24 * 3600;
  await send(pool.connect(insurer).createTemplate({
    crop: "wheat", region: "Akmola", thresholdMm: 120,
    payoutPerPolicy: ethers.parseEther("2"), premium: ethers.parseEther("0.1"),
    seasonEnd, toleranceMm: 10,
  }));

  console.log("\n4. Insurer funds the pool with 10");
  await send(pool.connect(insurer).fundPool(1, { value: ethers.parseEther("10") }));

  console.log("\n5. Two farmers buy policies for 0.1 each");
  await send(pool.connect(farmer1).buyPolicy(1, { value: ethers.parseEther("0.1") }));
  await send(pool.connect(farmer2).buyPolicy(1, { value: ethers.parseEther("0.1") }));
  console.log("   Policies sold:", (await pool.holderCount(1)).toString());

  console.log("\n6. The season ends (time moves forward)");
  await time.increaseTo(seasonEnd);

  console.log("\n7. Two independent providers report rainfall: 95 mm and 101 mm");
  await send(pool.connect(provider1).submitReading(1, 95));
  await send(pool.connect(provider2).submitReading(1, 101));
  console.log("   Recorded rainfall:", (await pool.getTemplate(1)).rainfallMm.toString(), "mm (threshold 120 mm)");

  console.log("\n8. Anyone calls evaluateAndPay: payouts are automatic");
  const b1 = await ethers.provider.getBalance(farmer1.address);
  const b2 = await ethers.provider.getBalance(farmer2.address);
  await send(pool.evaluateAndPay(1));
  const a1 = await ethers.provider.getBalance(farmer1.address);
  const a2 = await ethers.provider.getBalance(farmer2.address);
  console.log("   Farmer 1 received:", show(a1 - b1));
  console.log("   Farmer 2 received:", show(a2 - b2));

  console.log("\n9. Insurer closes the season: unused pool + premiums come back");
  const rc = await send(pool.connect(insurer).closeSeason(1));
  const ev = rc.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "SeasonClosed");
  console.log("   Returned to insurer:", show(ev.args[1]));

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });