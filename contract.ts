import {
  web3,
  setProvider,
  BN,
  Program,
  AnchorProvider,
  Wallet
} from '@coral-xyz/anchor'
import { bigInt } from 'snarkjs'

import idl from './otter_cash_idl.json'

require('dotenv').config()

const rpc = {
  devnet: process.env.DEVNET_RPC || '',
  mainnet: process.env.MAINNET_RPC || ''
}
if (rpc.devnet.startsWith('http') || rpc.mainnet.startsWith('http')) {
  throw new Error('RPC URL strings must not contain protocol prefixes.')
}
console.log('Using RPC config:', { devnet: rpc.devnet, mainet: rpc.mainnet })

const OTTER_PROGRAM_ID = new web3.PublicKey(
  'otterXYtgZ5DRUGX6JGtcZPg3GoWxEqcLrb9MjeCv3X'
)
let provider: AnchorProvider
let program: Program

export function setAnchorProvider (network: 'devnet' | 'mainnet') {
  let networkUrl: string
  if (network === 'devnet') {
    networkUrl = 'https://' + rpc.devnet
  } else if (network === 'mainnet') {
    networkUrl = 'https://' + rpc.mainnet
  } else {
    throw new Error('Unreachable.')
  }
  const connection = new web3.Connection(
    networkUrl,
    {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 120000,
      disableRetryOnRateLimit: false
    }
  )
  provider = new AnchorProvider(
    connection,
    Wallet.local(),
    {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed'
    }
  )
  setProvider(provider)
  // @ts-ignore
  program = new Program(idl, OTTER_PROGRAM_ID)
}

const ROUNDS_PER_IX_VKX = 1
const IXS_PER_TX_WITHDRAW = 7
const NUM_ADVANCES_WITHDRAW = 6 * (Math.ceil(256 / ROUNDS_PER_IX_VKX) + 1) + 4 * (11 + 65 * 11 + 25 + 256 * 5 + 9 + 256 * 5 + 2 + 256 * 5 + 34)

if (NUM_ADVANCES_WITHDRAW % IXS_PER_TX_WITHDRAW === 0) {
  throw new Error(
    'NUM_ADVANCES_WITHDRAW should not be a multiple of IXS_PER_TX_WITHDRAW for ix logic to work.'
  )
}

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

interface withdrawTxType {
  tx: web3.Transaction,
  signers: any[]
}
async function signWithdrawSubset (
  withdrawTxsSubset: withdrawTxType[]
): Promise<web3.Transaction[]> {
  // Adapted from anchor.program.provider.sendAll.
  const blockhash = await provider.connection.getRecentBlockhash()
  const txs = withdrawTxsSubset.map((r) => {
    const tx = r.tx
    let signers = r.signers
    if (signers === undefined) {
      signers = []
    }
    tx.feePayer = provider.wallet.publicKey
    tx.recentBlockhash = blockhash.blockhash
    signers
      .filter((s): s is web3.Signer => s !== undefined)
      .forEach((kp) => {
        tx.partialSign(kp)
      })
    return tx
  })
  return await provider.wallet.signAllTransactions(txs)
}

export async function withdrawInit (withdrawState, proof): Promise<void> {
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

  const withdrawInitTx = program.transaction.withdrawInit(
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
        user: provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId
      },
      signers: [withdrawState]
    }
  )
  // Send a bunch of withdrawInit, and return when one confirms.
  const withdrawInitPromises: any[] = [];
  for (let i = 0; i < 3; i++) {
    const withdrawInitTxSigned = (await signWithdrawSubset([
      { tx: withdrawInitTx, signers: [withdrawState] }
    ]))[0]
    const withdrawInitTxSignature = await provider.connection.sendRawTransaction(
      withdrawInitTxSigned.serialize(),
      { skipPreflight: false, maxRetries: 1024 }
    )
    console.log('Sent withdrawInit tx with signature: ' + withdrawInitTxSignature)
    const initPromise = provider.connection.confirmTransaction(withdrawInitTxSignature, 'confirmed')
    withdrawInitPromises.push(initPromise);
    await sleep(1000)
  }
  await Promise.allSettled(withdrawInitPromises)
    .then((results) => {
      const errors: any[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          console.log("WithdrawInit confirmed")
          return; // Return if one succeeds
        } else {
          errors.push(result.reason); // Collect errors from rejected promises
        }
      }
      if (errors.length === withdrawInitPromises.length) {
        // If all promises failed, log the errors and throw an exception
        errors.forEach(error => console.error('withdrawInit promise failed:', error));
        throw new Error('All withdrawInit promieses failed');
      }
    });
}

export async function allWithdrawAdvance (withdrawState: web3.Keypair) {
  const NUM_COMPLETE_TXS = Math.floor(NUM_ADVANCES_WITHDRAW / IXS_PER_TX_WITHDRAW)
  const NUM_REMAINDER_IXS = NUM_ADVANCES_WITHDRAW % IXS_PER_TX_WITHDRAW

  const withdrawAdvanceIxs: web3.TransactionInstruction[] = []
  for (let i = 0; i < NUM_COMPLETE_TXS * IXS_PER_TX_WITHDRAW + NUM_REMAINDER_IXS; i++) {
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

  const withdrawAdvanceTxs: withdrawTxType[] = []
  for (let i = 0; i < Math.ceil(withdrawAdvanceIxs.length / IXS_PER_TX_WITHDRAW); i++) {
    const tx = new web3.Transaction()
    for (const ix of withdrawAdvanceIxs.slice(
      IXS_PER_TX_WITHDRAW * i, IXS_PER_TX_WITHDRAW * (i + 1)
    )) {
      tx.add(ix)
    }
    withdrawAdvanceTxs.push({ tx: tx, signers: [] })
  }

  async function getLinearPhase (): Promise<number> {
    const withdrawStateAccountInfo = await program.account.withdrawState.getAccountInfo(
      withdrawState.publicKey
    )
    if (withdrawStateAccountInfo === null) {
      return 0
    }

    const withdrawStateData = withdrawStateAccountInfo.data
    if (withdrawStateData.length !== 6536) {
      throw new Error(`Unreachable: WithdrawState data length should be 6536, the Anchor v0.24.2 size. Instead, it was ${withdrawStateData.length}`)
    }

    // Manually deserialize the phases.
    const phaseGlobVkxOrPairing = withdrawStateData.readUInt8(392 + 64)
    const phaseVkxIter = withdrawStateData.readUInt8(392 + 65)
    const phaseVkxMulIter = withdrawStateData.readUInt16LE(392 + 66)
    const phasePairingIter = withdrawStateData.readUInt8(392 + 68)
    const phasePairingIterStep = withdrawStateData.readUInt16LE(392 + 70)

    // linearPhase is between 0 and 20086, inclusive.
    let linearPhase = 0
    switch (phaseGlobVkxOrPairing) {
      case 0:
        linearPhase = 257 * phaseVkxIter + phaseVkxMulIter
        break
      case 1:
        linearPhase = 257 * 6 + 4635 * phasePairingIter + phasePairingIterStep
        break
      case 2:
        linearPhase = 257 * 6 + 4636 * 4
        break
      default:
        throw new Error('Unreachable.')
    }
    return linearPhase
  }

  // Send and confirm the final (spare change) transaction.
  for (let i = 0; i < 10; i++) {
    try {
      console.log('Trying withdrawAdvance (spare change) on index ' + i)
      const signedFinalTx = (await signWithdrawSubset(withdrawAdvanceTxs.slice(-1)))[0]
      const signedFinalTxSignature = await provider.connection.sendRawTransaction(
        signedFinalTx.serialize(),
        { skipPreflight: true, maxRetries: 1024 }
      )
      console.log('Sent withdrawAdvance (spare change) tx with signature: ' + signedFinalTxSignature)
      await provider.connection.confirmTransaction(signedFinalTxSignature, 'confirmed')
      console.log('Confirmed withdrawAdvance (spare change).')
      break
    } catch {
      console.log('Caught withdrawAdvance (spare change) error on index ' + i)
      if (i === 9) {
        throw new Error('All withdrawAdvance (spare change) attempts failed.')
      }
    }
  }

  // While the linearPhase is not maximum, continue sending newly-signed transactions.
  let iterNum = 0
  while (true) {
    let linearPhase
    try {
      linearPhase = await getLinearPhase()
    } catch (error) {
      console.log('get linearPhase error:', error)
      throw error
    }
    console.log(`linearPhase = ${linearPhase}`)
    if (linearPhase === 20086) {
      console.log('Reached max linearPhase')
      return
    }
    const fracRemaining = 1 - linearPhase / 20086
    let numTxsToSend, maxRetries, sleepTime: number
    if (fracRemaining > 0.2) {
      numTxsToSend = Math.min(
        withdrawAdvanceTxs.length - 1,
        Math.ceil(NUM_COMPLETE_TXS * fracRemaining),
        50
      )
      maxRetries = 1024
      sleepTime = 250
    } else {
      numTxsToSend = Math.min(
        withdrawAdvanceTxs.length - 1,
        Math.ceil(NUM_COMPLETE_TXS * fracRemaining),
        50
      )
      maxRetries = 1024
      sleepTime = 250
    }
    const signedTxs = await signWithdrawSubset(
      withdrawAdvanceTxs.slice(0, numTxsToSend)
    )
    await Promise.all(signedTxs.map(async tx => {
      try {
        const rawTx = tx.serialize()
        const txid = await provider.connection.sendRawTransaction(
          rawTx,
          { skipPreflight: true, maxRetries: maxRetries }
        )
        console.log('txid', txid)
        return txid
      } catch (error) {
        try {
          console.log('retry', error)
          const rawTx = tx.serialize()
          const txid = await provider.connection.sendRawTransaction(
            rawTx,
            { skipPreflight: true, maxRetries: maxRetries }
          )
          console.log('txid', txid)
          return txid
        } catch (error) {
          console.log('retry 2', error)
          const rawTx = tx.serialize()
          const txid = await provider.connection.sendRawTransaction(
            rawTx,
            { skipPreflight: true, maxRetries: maxRetries }
          )
          console.log('txid', txid)
          return txid
        }
      }
    }))
    await sleep(sleepTime)
    iterNum += 1
    if (iterNum > 1000) {
      throw new Error('More than 1000 iters to advance the withdraw.')
    }
  }
}

export async function withdrawFinalize (withdrawState, proof) {
  await sleep(5000)
  const [merkleState, merkleStateBump] = await getMerkleState()

  const withdrawStateAccountInfo = await program.account.withdrawState.getAccountInfo(
    withdrawState.publicKey
  )
  if (withdrawStateAccountInfo === null) {
    throw new Error('withdrawState had no data.')
  }
  const withdrawStateData = withdrawStateAccountInfo.data

  if (withdrawStateData.length !== 6536) {
    throw new Error(`Unreachable: WithdrawState data length should be 6536, the Anchor v0.24.2 size. Instead, it was ${withdrawStateData.length}`)
  }
  const nullifierHashBytes = withdrawStateData.slice(296, 296 + 8 * 4).reverse()
  const [nullifierHashPDA, nullifierHashPDABump] = await web3.PublicKey.findProgramAddress(
    [nullifierHashBytes],
    program.programId
  )

  const recipient = new web3.PublicKey(Buffer.from(proof.publicSignals[2].slice(2), 'hex').reverse())

  const withdrawFinalizeTx = program.transaction.withdrawFinalize(
    merkleStateBump,
    nullifierHashPDABump,
    nullifierHashBytes,
    {
      accounts: {
        merkleState: merkleState,
        withdrawState: withdrawState.publicKey,
        nullifierHashPda: nullifierHashPDA,
        recipient: recipient,
        relayer: provider.wallet.publicKey,
        user: provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId
      }
    }
  )
  // Send a bunch of withdrawFinalize, and return when one confirms.
  const withdrawFinalizePromises: any[] = [];
  for (let i = 0; i < 25; i++) {
    const withdrawFinalizeTxSigned = (await signWithdrawSubset([
      { tx: withdrawFinalizeTx, signers: [] }
    ]))[0]
    const withdrawFinalizeTxSignature = await provider.connection.sendRawTransaction(
      withdrawFinalizeTxSigned.serialize(),
      { skipPreflight: false, maxRetries: 1024 }
    )
    console.log('Sent withdrawFinalize tx with signature: ' + withdrawFinalizeTxSignature)
    const finalizePromise = provider.connection.confirmTransaction(withdrawFinalizeTxSignature, 'confirmed')
    withdrawFinalizePromises.push(finalizePromise);
  }
  await Promise.allSettled(withdrawFinalizePromises)
    .then((results) => {
      const errors: any[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          console.log("WithdrawFinalize confirmed")
          return; // Return if one succeeds
        } else {
          errors.push(result.reason); // Collect errors from rejected promises
        }
      }
      if (errors.length === withdrawFinalizePromises.length) {
        // If all promises failed, log the errors and throw an exception
        errors.forEach(error => console.error('withdrawFinalize promise failed:', error));
        throw new Error('All withdrawFinalize promieses failed');
      }
    });
}
