import {
  web3,
  setProvider,
  BN,
  Program,
  Provider,
  Wallet
} from '@project-serum/anchor'
import { bigInt } from 'snarkjs'

import idl from './otter_cash_idl.json'

const OTTER_PROGRAM_ID = new web3.PublicKey(
  'otterM8AATqnFXFNcPoWxTix75wou9A47xt6JbZxzS3'
)
const NETWORK_URL = 'https://nameless-icy-violet.solana-devnet.quiknode.pro/90ccb55668a25df17eaa22f5eda5897657dbc72e/'
const connection = new web3.Connection(
  NETWORK_URL,
  {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    disableRetryOnRateLimit: false
  }
)
const provider = new Provider(
  connection,
  Wallet.local(),
  {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    maxRetries: 16
  }
)
setProvider(provider)
// @ts-ignore
const program = new Program(idl, OTTER_PROGRAM_ID)

const ROUNDS_PER_IX_VKX = 1
const IXS_PER_TX_WITHDRAW = 73
const NUM_ADVANCES_WITHDRAW = 6 * (Math.ceil(256 / ROUNDS_PER_IX_VKX) + 1) + 4 * (11 + 65 * 11 + 25 + 256 * 5 + 9 + 256 * 5 + 2 + 256 * 5 + 34)

const sleep = ms => new Promise((resolve, reject) => setTimeout(resolve, ms))

async function getMerkleState (): Promise<[web3.PublicKey, number]> {
  return await web3.PublicKey.findProgramAddress(
    [Buffer.from('merkle')],
    OTTER_PROGRAM_ID
  )
}

function u256BuffToLittleEndianBN (buff: Buffer): BN[] {
  if (buff.length !== 32) {
    throw Error('Unreachable.')
  }
  return [
    new BN(bigInt.beBuff2int(buff.slice(24, 32))),
    new BN(bigInt.beBuff2int(buff.slice(16, 24))),
    new BN(bigInt.beBuff2int(buff.slice(8, 16))),
    new BN(bigInt.beBuff2int(buff.slice(0, 8)))
  ]
}

export async function withdrawInit (proof): Promise<web3.Keypair> {
  const [merkleState, merkleStateBump] = await getMerkleState()
  const proofArray: BN[][] = []
  for (let i = 0; i < 8; i++) {
    const thisProofPoint = Buffer.from(proof.proof.slice(2 + 64 * i, 2 + 64 * (i + 1)), 'hex')
    proofArray.push(u256BuffToLittleEndianBN(thisProofPoint))
  }

  // Swap (2, 3) and (4, 5) because Ethereum uses a different encoding of G2
  // points than ZCash BN library.
  const tmp1 = proofArray[2]
  proofArray[2] = proofArray[3]
  proofArray[3] = tmp1
  const tmp2 = proofArray[4]
  proofArray[4] = proofArray[5]
  proofArray[5] = tmp2

  const withdrawState = web3.Keypair.generate()
  await program.rpc.withdrawInit(
    merkleStateBump,
    proofArray,
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[0].slice(2), 'hex')),
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[1].slice(2), 'hex')),
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[2].slice(2), 'hex')),
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[3].slice(2), 'hex')),
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[4].slice(2), 'hex')),
    u256BuffToLittleEndianBN(Buffer.from(proof.publicSignals[5].slice(2), 'hex')),
    {
      accounts: {
        withdrawState: withdrawState.publicKey,
        merkleState: merkleState,
        user: program.provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId
      },
      signers: [withdrawState]
    }
  )
  return withdrawState
}

export async function allWithdrawAdvance (withdrawState: web3.Keypair, requestDelay: number) {
  const withdrawAdvanceIxs: web3.TransactionInstruction[] = []
  for (let i = 0; i < NUM_ADVANCES_WITHDRAW; i++) {
    const ix = program.instruction.withdrawAdvance(
      Math.floor(i / IXS_PER_TX_WITHDRAW),
      {
        accounts: {
          withdrawState: withdrawState.publicKey
        }
      }
    )
    withdrawAdvanceIxs.push(ix)
  }

  const withdrawAdvancePromises: Promise<string>[] = []
  // We can put IXS_PER_TX_WITHDRAW ixs into a single tx, and each ix will get a
  // 200k compute budget.
  for (let i = 0; i < Math.ceil(NUM_ADVANCES_WITHDRAW / IXS_PER_TX_WITHDRAW); i++) {
    console.log(i)
    const tx = new web3.Transaction()
    for (const ix of withdrawAdvanceIxs.slice(
      IXS_PER_TX_WITHDRAW * i, IXS_PER_TX_WITHDRAW * (i + 1)
    )) {
      tx.add(ix)
    }
    withdrawAdvancePromises.push(program.provider.send(tx))
    await sleep(requestDelay)
  }
  await Promise.all(withdrawAdvancePromises)
}

export async function withdrawFinalize (withdrawState, proof) {
  const [merkleState, merkleStateBump] = await getMerkleState()
  const withdrawStateBeforeFinalize = await program.account.withdrawState.fetch(
    withdrawState.publicKey
  )

  const nullifierHashBN = withdrawStateBeforeFinalize.publicSignals[1]
  const nullifierHashBytes = Buffer.concat([
    nullifierHashBN[3].toBuffer('be', 8),
    nullifierHashBN[2].toBuffer('be', 8),
    nullifierHashBN[1].toBuffer('be', 8),
    nullifierHashBN[0].toBuffer('be', 8)
  ])
  const [nullifierHashPDA, nullifierHashPDABump] = await web3.PublicKey.findProgramAddress(
    [nullifierHashBytes],
    program.programId
  )

  const recipient = new web3.PublicKey(Buffer.from(proof.publicSignals[2].slice(2), 'hex').reverse())

  await program.rpc.withdrawFinalize(
    merkleStateBump,
    nullifierHashPDABump,
    nullifierHashBytes,
    {
      accounts: {
        merkleState: merkleState,
        withdrawState: withdrawState.publicKey,
        nullifierHashPda: nullifierHashPDA,
        recipient: recipient,
        relayer: program.provider.wallet.publicKey,
        user: program.provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId
      }
    }
  )
}
