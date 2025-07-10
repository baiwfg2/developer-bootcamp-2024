use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{Offer, ANCHOR_DISCRIMINATOR};

use super::transfer_tokens;

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct MakeOffer<'info> {
    // 创建交易的用户（出价者）
    #[account(mut)]
    pub maker: Signer<'info>,

    /*
    作用: 用户要提供的代币A的铸币账户
    类型: Mint 表示这是一个代币的铸币账户
    用途: 定义代币A的类型（比如USDC、SOL等）
    */
    #[account(mint::token_program = token_program)]
    pub token_mint_a: InterfaceAccount<'info, Mint>,

    /*
    作用: 用户想要的代币B的铸币账户
    类型: Mint 表示这是一个代币的铸币账户
    用途: 定义代币B的类型（用户想要换取的代币）
    */
    #[account(mint::token_program = token_program)]
    pub token_mint_b: InterfaceAccount<'info, Mint>,

    /*
    作用: 用户拥有的代币A的账户
    类型: TokenAccount 表示这是一个代币账户
    约束:
    mut 表示会被修改（转出代币）
    associated_token::mint = token_mint_a 确保是代币A的账户
    associated_token::authority = maker 确保是用户的账户
    用途: 用户从这里转出代币A到vault
    */
    #[account(
        mut,
        associated_token::mint = token_mint_a,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    pub maker_token_account_a: InterfaceAccount<'info, TokenAccount>,

    /*
    作用: 存储交易信息的账户
    类型: Offer 自定义结构体
    约束:
    init 表示这是一个新创建的账户
    payer = maker 表示用户支付创建费用
    seeds 定义PDA（Program Derived Address）的种子
    bump 自动生成bump seed
    用途: 记录交易的所有信息（ID、用户、代币类型、数量等）
    */
    #[account(
        init,
        payer = maker,
        space = ANCHOR_DISCRIMINATOR + Offer::INIT_SPACE,
        seeds = [b"offer", maker.key().as_ref(), id.to_le_bytes().as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    /*
    作用: 托管代币A的保险库账户
    类型: TokenAccount 表示这是一个代币账户
    约束:
    init 表示这是一个新创建的账户
    payer = maker 表示用户支付创建费用
    associated_token::mint = token_mint_a 确保是代币A的账户
    associated_token::authority = offer 以offer账户为权限
    用途: 临时存储用户提供的代币A，等待其他用户接受交易
    */
    #[account(
        init,
        payer = maker,
        associated_token::mint = token_mint_a,
        associated_token::authority = offer,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    // 用途: 用于创建新账户（offer和vault账户）
    pub system_program: Program<'info, System>,
    /*
    作用: SPL Token程序接口
    用途: 用于代币转账操作
    */
    pub token_program: Interface<'info, TokenInterface>,
    /*
    作用: 关联代币账户程序
    用途: 用于创建关联代币账户（vault账户）
    */
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn send_offered_tokens_to_vault(
    context: &Context<MakeOffer>,
    token_a_offered_amount: u64,
) -> Result<()> {
    transfer_tokens(
        &context.accounts.maker_token_account_a,
        &context.accounts.vault,
        &token_a_offered_amount,
        &context.accounts.token_mint_a,
        &context.accounts.maker,
        &context.accounts.token_program,
    )
}

pub fn save_offer(context: Context<MakeOffer>, id: u64, token_b_wanted_amount: u64) -> Result<()> {
    context.accounts.offer.set_inner(Offer {
        id,
        maker: context.accounts.maker.key(),
        token_mint_a: context.accounts.token_mint_a.key(),
        token_mint_b: context.accounts.token_mint_b.key(),
        token_b_wanted_amount,
        bump: context.bumps.offer,
    });
    Ok(())
}
