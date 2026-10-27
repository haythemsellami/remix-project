# Solidity tests and console output

Select Monad Next or Monad Ten in Deploy & Run, then open the Solidity Unit Testing plugin. It uses the selected VM provider for deployment, hooks, test transactions and read-only calls. Debug buttons on test results open the corresponding recorded execution, including assertion failures and reverted transactions.

The [MonadUnit_test.sol](../examples/MonadUnit_test.sol) fixture covers setup hooks, assertions, transaction reverts, boolean read-only tests, and sender/value annotations. It deliberately includes failures: Monad Next reports four passes and three failures; Monad Ten reports three passes and four failures because its fork rejects the fixture's Monad extension. Compile for Cancun with Solidity 0.8.24 or newer.

Import `hardhat/console.sol` to display console output in Remix's terminal, including output attached to Solidity test results. [ConsoleDemo.sol](../examples/ConsoleDemo.sol) demonstrates the Deploy & Run flow. The wrapper captures raw console calls independently of instruction-trace limits, and the provider decodes Remix's supported signatures, including legacy integer selectors. Unknown or malformed payloads are ignored without changing execution results. Console output survives reverts and state save/restore; older saves without console data remain readable.

The command-line test runner still uses its existing EthereumJS backend.
