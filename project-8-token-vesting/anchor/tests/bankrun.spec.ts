// No imports needed: web3, anchor, pg and more are globally available
import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN, Program } from "@coral-xyz/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

import { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

import IDL from "../target/idl/vesting.json";
import { Vesting } from "../target/types/vesting";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";

// Original method is using bankrun libraries, but since it has been deprecated,
// I refactored using native anchor testing framework

describe("Vesting Smart Contract Tests", () => {
  const companyName = "Company";
  let beneficiary: Keypair;
  let vestingAccountKey: PublicKey;
  let treasuryTokenAccount: PublicKey;
  let employeeAccount: PublicKey;
  let provider: anchor.AnchorProvider;
  let program: Program<Vesting>;
  let employer: Keypair;
  let payer: Keypair;
  let mint: PublicKey;
  // let beneficiaryProvider: anchor.AnchorProvider;
  // let program2: Program<Vesting>;
  const MY_DECIMALS = 2;

  beforeAll(async () => {
    beneficiary = new anchor.web3.Keypair();

    provider = anchor.AnchorProvider.env();
    // rent is needed when claiming tokens for creating employee_token_acount
    await provider.connection.requestAirdrop(beneficiary.publicKey,
      1 * LAMPORTS_PER_SOL);
    anchor.setProvider(provider);
    program = anchor.workspace.Vesting as Program<Vesting>;
    console.log("program id:", program.programId.toString(),
      ",beneficiary:", beneficiary.publicKey.toString());

    employer = (provider.wallet as anchor.Wallet).payer;
    payer = employer;

    // Create a new mint
    mint = await createMint(provider.connection, payer,
      payer.publicKey, null, MY_DECIMALS);
    console.log("Mint address:", mint.toBase58(), "payer:", payer.publicKey.toString());

    // Derive PDAs
    [vestingAccountKey] = PublicKey.findProgramAddressSync(
      [Buffer.from(companyName)],
      program.programId
    );

    [treasuryTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vesting_treasury"), Buffer.from(companyName)],
      program.programId
    );

    [employeeAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("employee_vesting"),
        beneficiary.publicKey.toBuffer(),
        vestingAccountKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("should create a vesting account", async () => {
    const tx = await program.methods
      .createVestingAccount(companyName)
      .accounts({
        signer: employer.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    const vestingAccountData = await program.account.vestingAccount.fetch(
      vestingAccountKey,
      "confirmed"
    );
    console.log(
      "Vesting Account Data:",
      JSON.stringify(vestingAccountData, null, 2)
    );

    console.log("Create Vesting Account Transaction Signature:", tx);
  });

  it("should fund the treasury token account", async () => {
    const amount = 10_000 * 10 ** 9;

    // 创建 employer 的 ATA（关联账户）
    // const employerTokenAccount = await getOrCreateAssociatedTokenAccount(
    //   provider.connection,
    //   payer,
    //   mint,
    //   payer.publicKey
    // );

    // 给 treasuryTokenAccount 铸币
    const mintTx = await mintTo(
      provider.connection,
      payer,
      mint,
      treasuryTokenAccount,
      payer, // mint authority/signer
      amount
    );

    console.log("Mint to Treasury Transaction Signature:", mintTx);
  });

  it("should create an employee vesting account", async () => {
    const tx2 = await program.methods
      .createEmployeeVesting(new BN(0), new BN(100), new BN(100), new BN(0))
      .accounts({
        beneficiary: beneficiary.publicKey,
        vestingAccount: vestingAccountKey,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
      //skipPreflight: 适合你确信交易不会失败，或者预检经常报奇怪的错误但实际能成功时

    console.log("Create Employee Account Transaction Signature:", tx2);
    console.log("Employee account", employeeAccount.toBase58());
  });

  it("should claim tokens", async () => {
    //await new Promise((resolve) => setTimeout(resolve, 1000));

    // author says: the signer for this instruction is goint to be the beneficiary and not the employer
    /*
      The following is what I found by trial and error:

      1. If not perform beneficiary airdrop，report:(won't be printed without try/catch)：
      Error:  SendTransactionError: Simulation failed.
    Message: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1.
    Logs:
    [
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1595 of 181545 compute units",
      "Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA=",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Transfer: insufficient lamports 0, need 2039280",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1"

      2. unknown signer: xxx When only commenting out the line
        // beneficiary: beneficiary.publicKey,

      3. when commenting out the line,report:
          Missing signature for public key xxx（beneficiary's key)
          Solana 要求：只要合约指令声明了某个账户为 signer，交易就必须用对应私钥签名
        // .signers([beneficiary])
        
      4. 除了tokenProgram, beneficiary，其他字段似乎都可注释掉，用例可过
        如果仅注释了tokenProgram，则会报错：
          Reached maximum depth for account resolution. Unresolved accounts: `employeeTokenAccount
        原因（copilot gives)： 它是 SPL Token 程序的地址，不是 PDA，也不是可以自动推导的账户，
          但它的 presence 让 Anchor 能正确识别和推导后续的 token 相关账户（比如 employeeTokenAccount
      
      5. 同时注释掉beneficiary和signers，报错：
        AnchorError caused by account: employee_account. Error Code: 
          AccountNotInitialized. Error Number: 3012. Error Message: 
          The program expected this account to be already initialize
      6. 既然第5点报employee_acount 未初使化，则尝试在同时注释它俩时，添加employeeAccount: 报：
      AnchorError caused by account: employee_account. Error Code: ConstraintSeeds. 
      Error Number: 2006. Error Message: A seeds constraint was violated.
        Program log: Left:
        Program log: BJRNd9PYp6oJNkioxJAdoZgNgt4TnNqGbKd6KuQVw9TS
        Program log: Right:
        Program log: 6xyHAzfxnWrjqK7zXTrTc9uw5zMh47Yr4VLFqYAu6mP
        以上这个报错在 .anchor/ 中没找到相关日志,但错误描述是在anchor 源码中的
    */
   try {
    const tx3 = await program.methods
      .claimTokens(companyName)
      .accounts({
        beneficiary: beneficiary.publicKey,
        //employeeAccount: employeeAccount, // pda 帐户可自动推导
        //vestingAccount: vestingAccountKey,
        //mint,
        //treasuryTokenAccount: treasuryTokenAccount,
        //employeeTokenAccount: employeeTokenAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        //associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([beneficiary])
      .rpc({ commitment: "confirmed" });
    } catch (err) {
      throw err;
    }
  });
});
