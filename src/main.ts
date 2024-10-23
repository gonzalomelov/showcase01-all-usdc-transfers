// main.js
// This is the main executable of the squid indexer.

// EvmBatchProcessor is the class responsible for data retrieval and processing.
import {EvmBatchProcessor} from '@subsquid/evm-processor'
// RedisDatabase is the class responsible for data storage.
import {RedisDatabase} from '@gonzalomelov/mq-store'
// usdcAbi is a utility module generated from the JSON ABI of the USDC contract.
// It contains methods for event decoding, direct RPC queries and some useful
// constants.
import * as usdcAbi from './abi/usdc'

const USDC_CONTRACT_ADDRESS =
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

// First we configure data retrieval.
const processor = new EvmBatchProcessor()
  // SQD Network gateways are the primary source of blockchain data in
  // squids, providing pre-filtered data in chunks of roughly 1-10k blocks.
  // Set this for a fast sync.
  .setGateway('https://v2.archive.subsquid.io/network/ethereum-mainnet')
  // Another data source squid processors can use is chain RPC.
  // In this particular squid it is used to retrieve the very latest chain data
  // (including unfinalized blocks) in real time. It can also be used to
  //   - make direct RPC queries to get extra data during indexing
  //   - sync a squid without a gateway (slow)
  .setRpcEndpoint('https://rpc.ankr.com/eth')
  // The processor needs to know how many newest blocks it should mark as "hot".
  // If it detects a blockchain fork, it will roll back any changes to the
  // database made due to orphaned blocks, then re-run the processing for the
  // main chain blocks.
  .setFinalityConfirmation(75)
  // .addXXX() methods request data items. In this case we're asking for
  // Transfer(address,address,uint256) event logs emitted by the USDC contract.
  //
  // We could have omitted the "address" filter to get Transfer events from
  // all contracts, or the "topic0" filter to get all events from the USDC
  // contract, or both to get all event logs chainwide. We also could have
  // requested some related data, such as the parent transaction or its traces.
  //
  // Other .addXXX() methods (.addTransaction(), .addTrace(), .addStateDiff()
  // on EVM) are similarly feature-rich.
  .addLog({
    range: { from: 6_082_465 },
    address: [USDC_CONTRACT_ADDRESS],
    topic0: [usdcAbi.events.Transfer.topic],
  })
  // .setFields() is for choosing data fields for the selected data items.
  // Here we're requesting hashes of parent transaction for all event logs.
  .setFields({
    log: {
      transactionHash: true,
    },
  })

// RedisDatabase objects store the data to Redis. They are capable of
// handling the rollbacks that occur due to blockchain forks.
//
// There are also Database classes for storing data to files and BigQuery
// datasets.
const db = new RedisDatabase({url: 'redis://localhost:6379'})

// The processor.run() call executes the data processing. Its second argument is
// the handler function that is executed once on each batch of data. Processor
// object provides the data via "ctx.blocks". However, the handler can contain
// arbitrary TypeScript code, so it's OK to bring in extra data from IPFS,
// direct RPC calls, external APIs etc.
processor.run(db, async (ctx) => {
  // The data retrieved from the SQD Network gatewat and/or the RPC endpoint
  // is supplied via ctx.blocks
  for (let block of ctx.blocks) {
    // On EVM, each block has four iterables - logs, transactions, traces,
    // stateDiffs
    for (let log of block.logs) {
      if (log.address === USDC_CONTRACT_ADDRESS &&
          log.topics[0] === usdcAbi.events.Transfer.topic) {
        // SQD's very own EVM codec at work - about 20 times faster than ethers
        let {from, to, value} = usdcAbi.events.Transfer.decode(log)
        ctx.store.hSet(`transfer:${log.id}`, {
          id: log.id,
          block: block.header.height,
          from,
          to,
          value: value.toString(),
          txnHash: log.transactionHash
        })
      }
    }
  }
})
