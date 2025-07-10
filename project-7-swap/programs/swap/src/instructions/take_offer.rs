use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
        TransferChecked,
    },
};

use crate::Offer;

use super::transfer_tokens;

#[derive(Accounts)]
pub struct TakeOffer<'info> {
    /*
    作用：接收方（接受报价的人），需要签名。
    用途：发起“接受报价”操作的用户
    */
    #[account(mut)]
    pub taker: Signer<'info>,

    /*
    作用：出价方（最初发起报价的人）。
    用途：用于接收返还的SOL（如关闭账户时返还租金），以及校验身份
    */
    #[account(mut)]
    pub maker: SystemAccount<'info>,

    // 被托管的代币A的mint账户
    pub token_mint_a: InterfaceAccount<'info, Mint>,

    // 被需求的代币B的mint账户
    pub token_mint_b: InterfaceAccount<'info, Mint>,

    /*
    作用：taker（接收方）用来接收A币的账户。
    用途：当taker接受报价后，A币会从vault转到这个账户

    用Box<>的原因（cursor回复不一定对）：
    在 Anchor 0.26+，如果你在账户约束里用了 init_if_needed，必须用 Box<> 包裹。
    这是因为 Anchor 需要在运行时判断这个账户到底是“已存在”还是“需要新建”，而不是在编译时就能确定
    这里 taker_token_account_a 可能已经存在，也可能需要新建。
    Anchor 需要在运行时动态分配和管理这个账户，所以用 Box<>
    
    如果账户一定存在，比如 #[account(mut)]，就直接用 InterfaceAccount<'info, TokenAccount>。
    只有在 init_if_needed 或者某些 CPI 场景下，才需要 Box<>
    */
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_a,
        associated_token::authority = taker,
        associated_token::token_program = token_program,
    )]
    pub taker_token_account_a: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
    作用：taker（接收方）持有B币的账户。
    用途：taker会从这里转出B币给maker。
    约束：必须已经存在（mut）。
    */
    #[account(
        mut,
        associated_token::mint = token_mint_b,
        associated_token::authority = taker,
        associated_token::token_program = token_program,
    )]
    pub taker_token_account_b: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
    作用：maker（出价方）用来接收B币的账户。
    用途：taker把B币转到这里。
    */
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_b,
        associated_token::authority = maker,
        associated_token::token_program = token_program,
    )]
    pub maker_token_account_b: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
    作用：存储报价信息的账户。
    用途：校验报价的合法性、读取报价内容、关闭账户返还租金。
    约束：
    mut：会被修改（如关闭）
    close = maker：关闭时租金返还给maker (在第四课也有close用法)
    has_one = maker：必须属于maker
    has_one = token_mint_a/token_mint_b：mint类型校验
    seeds/bump：PDA校验
    */
    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = token_mint_a,
        has_one = token_mint_b,
        seeds = [b"offer", maker.key().as_ref(), offer.id.to_le_bytes().as_ref()],
        bump = offer.bump
    )]
    offer: Account<'info, Offer>,

    /*
    作用：托管A币的保险库账户。
    用途：A币从这里转给taker。
    */
    #[account(
        mut,
        associated_token::mint = token_mint_a,
        associated_token::authority = offer,
        associated_token::token_program = token_program,
    )]
    vault: InterfaceAccount<'info, TokenAccount>,

    // 用于创建/关闭账户等系统操作
    pub system_program: Program<'info, System>,
    /*
    作用：SPL Token程序接口。
    用途：用于代币转账等操作
    */
    pub token_program: Interface<'info, TokenInterface>,
    /*
    作用：关联代币账户程序。
    用途：用于自动创建关联代币账户
    */
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn send_wanted_tokens_to_maker(context: &Context<TakeOffer>) -> Result<()> {
    transfer_tokens(
        &context.accounts.taker_token_account_b,
        &context.accounts.maker_token_account_b,
        &context.accounts.offer.token_b_wanted_amount,
        &context.accounts.token_mint_b,
        &context.accounts.taker,
        &context.accounts.token_program,
    )
}

pub fn withdraw_and_close_vault(context: Context<TakeOffer>) -> Result<()> {
    /*
    作用：构造出 offer 账户的 PDA seeds，用于后续以 offer 账户为“签名者”进行授权。
    原因：vault 的 authority 是 offer（PDA），只有用 seeds 作为 signer，才能操作 vault。
     */
    let seeds = &[
        b"offer",
        context.accounts.maker.to_account_info().key.as_ref(),
        &context.accounts.offer.id.to_le_bytes()[..],
        &[context.accounts.offer.bump],
    ];
    let signer_seeds = [&seeds[..]];

    /*
    作用：准备 SPL Token 的 transfer_checked CPI 所需的账户。
    from：vault（保险库，存放A币）
    to：taker_token_account_a（taker的A币账户）
    mint：A币的mint
    authority：offer（PDA，vault的owner）
     */
    let accounts = TransferChecked {
        from: context.accounts.vault.to_account_info(),
        to: context.accounts.taker_token_account_a.to_account_info(),
        mint: context.accounts.token_mint_a.to_account_info(),
        authority: context.accounts.offer.to_account_info(),
    };

    let cpi_context = CpiContext::new_with_signer(
        context.accounts.token_program.to_account_info(),
        accounts,
        &signer_seeds,
    );

    /*
    作用：以 offer（PDA）为签名者，把 vault 里的所有A币转给 taker。
    transfer_checked：SPL Token 的安全转账函数，带有 decimals 校验
     */
    transfer_checked(
        cpi_context,
        context.accounts.vault.amount,
        context.accounts.token_mint_a.decimals,
    )?;

    /*
    作用：准备 SPL Token 的 close_account CPI 所需的账户。
    account：vault（要关闭的账户）
    destination：taker（关闭后租金返还给taker）
    authority：offer（PDA，vault的owner）
     */
    let accounts = CloseAccount {
        account: context.accounts.vault.to_account_info(),
        destination: context.accounts.taker.to_account_info(),
        authority: context.accounts.offer.to_account_info(),
    };

    // 作用：以 offer（PDA）为签名者，关闭 vault 账户，把剩余租金返还给 taker
    let cpi_context = CpiContext::new_with_signer(
        context.accounts.token_program.to_account_info(),
        accounts,
        &signer_seeds,
    );

    close_account(cpi_context)
}
