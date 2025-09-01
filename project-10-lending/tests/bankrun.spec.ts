// Remove the import since Mocha provides these globally
// import { describe, it } from "node:test";
import { config } from "dotenv";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, createMint, mintTo, createAccount } from "@solana/spl-token";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

import { PublicKey, Keypair, Connection } from "@solana/web3.js";

// Load environment variables
config();

// @ts-ignore
import IDL from "../target/idl/lending_protocol.json";
import { LendingProtocol } from "../target/types/lending_protocol";

describe("Lending Smart Contract Tests", async () => {
  let signer: Keypair;
  let usdcBankAccount: PublicKey;
  let solBankAccount: PublicKey;
  let mintUSDC: PublicKey;
  let mintSOL: PublicKey;
  let solUsdPriceFeedAccount: PublicKey;
  let usdcUsdPriceFeedAccount: PublicKey;
  let solTokenAccount: PublicKey;
  let provider: anchor.AnchorProvider;
  let program: Program<LendingProtocol>;

  const liquidationThreshold = new BN(0.5);

  before(async () => {
    const pyth = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    const devnetConnection = new Connection(process.env.DEVNET_RPC_URL);
    const accountInfo = await devnetConnection.getAccountInfo(pyth);

    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.LendingProtocol as Program<LendingProtocol>;
    console.log("programId:", program.programId.toString(), ", conn:", provider.connection.rpcEndpoint);
    console.log("pyth conn:", devnetConnection.rpcEndpoint);

    const pythSolanaReceiver = new PythSolanaReceiver({
      connection: provider.connection,
      wallet: provider.wallet as anchor.Wallet,
    });

    // look up in https://docs.pyth.network/price-feeds/price-feeds
    // price feed acccount: Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX
    const USDC_PRICE_FEED_ID =
      "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
    // price feed account: 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE
    const SOL_PRICE_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

    /*
    一个纯计算函数，它：
    - 不访问区块链
    - 不读取任何账户数据
    - 只是根据算法计算出地址
    所以即使传了本地连接给 PythSolanaReceiver,也能获取到price feed account
    */
    solUsdPriceFeedAccount = pythSolanaReceiver.getPriceFeedAccountAddress(
      0, SOL_PRICE_FEED_ID);
    usdcUsdPriceFeedAccount = pythSolanaReceiver.getPriceFeedAccountAddress(
      0, USDC_PRICE_FEED_ID);
      
    console.log("sol pricefeed:", solUsdPriceFeedAccount.toBase58());
    console.log("usdc pricefeed:", usdcUsdPriceFeedAccount.toBase58());

    // const solUsdPriceFeedAccountPubkey = new PublicKey(solUsdPriceFeedAccount);
    const solFeedAccountInfo = await devnetConnection.getAccountInfo(solUsdPriceFeedAccount);

    console.log("Pyth Account Info:", accountInfo);
    console.log("sol feed account info:", solFeedAccountInfo);

    program = new Program<LendingProtocol>(IDL as LendingProtocol, provider);

    signer = provider.wallet.payer;

    // create token type
    mintUSDC = await createMint(provider.connection, signer, signer.publicKey,
      null, 9
    );

    mintSOL = await createMint(provider.connection, signer,
      signer.publicKey, null, 9
    );

    [usdcBankAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), mintUSDC.toBuffer()],
      program.programId
    );

    [solBankAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), mintSOL.toBuffer()],
      program.programId
    );

    console.log("USDC Bank Account", usdcBankAccount.toBase58());
    console.log("SOL Bank Account", solBankAccount.toBase58());
  });

  it("Test Init User", async () => {
    const initUserTx = await program.methods
      .initUser(mintUSDC)
      .accounts({
        signer: signer.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Create User Account", initUserTx);
  });

  it("Test Init and Fund USDC Bank", async () => {
    const initUSDCBankTx = await program.methods
      .initBank(new BN(1), new BN(1))
      .accounts({
        signer: signer.publicKey,
        mint: mintUSDC,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Create USDC Bank Account", initUSDCBankTx);

    const amount = 10_000 * 10 ** 9;
    const mintTx = await mintTo(
      provider.connection,
      signer,
      mintUSDC,
      usdcBankAccount,
      signer,
      amount
    );

    console.log("Mint to USDC Bank Signature:", mintTx);
  });

  it("Test Init amd Fund SOL Bank", async () => {
    const initSOLBankTx = await program.methods
      .initBank(new BN(1), new BN(1))
      .accounts({
        signer: signer.publicKey,
        mint: mintSOL,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Create SOL Bank Account", initSOLBankTx);

    const amount = 10_000 * 10 ** 9;
    const mintSOLTx = await mintTo(
      provider.connection,
      signer,
      mintSOL,
      solBankAccount,
      signer,
      amount
    );

    console.log("Mint to SOL Bank Signature:", mintSOLTx);
  });

  it("Create and Fund Token Account", async () => {
    const USDCTokenAccount = await createAccount(
      provider.connection,
      signer,
      mintUSDC,
      signer.publicKey
    );

    console.log("USDC Token Account Created:", USDCTokenAccount);

    const amount = 10_000 * 10 ** 9;
    const mintUSDCTx = await mintTo(
      provider.connection,
      signer,
      mintUSDC,
      USDCTokenAccount,
      signer,
      amount
    );

    console.log("Mint to USDC Bank Signature:", mintUSDCTx);
  });

  it("Test Deposit USDC", async () => {
    const depositUSDC = await program.methods
      .deposit(new BN(100000000000))
      .accounts({
        signer: signer.publicKey,
        mint: mintUSDC,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Deposit USDC", depositUSDC);
  });

  it("Test Borrow SOL", async () => {
    const borrowSOL = await program.methods
      .borrow(new BN(1))
      .accounts({
        signer: signer.publicKey,
        mint: mintSOL,
        tokenProgram: TOKEN_PROGRAM_ID,
        priceUpdate: usdcUsdPriceFeedAccount,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Borrow SOL", borrowSOL);
  });

  it("Test Repay SOL", async () => {
    const repaySOL = await program.methods
      .repay(new BN(1))
      .accounts({
        signer: signer.publicKey,
        mint: mintSOL,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Repay SOL", repaySOL);
  });

  it("Test Withdraw", async () => {
    const withdrawUSDC = await program.methods
      .withdraw(new BN(100))
      .accounts({
        signer: signer.publicKey,
        mint: mintUSDC,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("Withdraw USDC", withdrawUSDC);
  });
});
