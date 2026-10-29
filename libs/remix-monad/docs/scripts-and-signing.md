# Scripts and signing

Compile [MonadDemo.sol](../examples/MonadDemo.sol) for Cancun and select Monad Next or Monad Ten. Open [deploy-script.js](../examples/deploy-script.js) and choose **Run with Ethers v6** from the editor's run menu. It deploys the contract, writes storage, checks its event, and saves the address in `monad-script.json`.

Next run [sign-and-execute.ts](../examples/sign-and-execute.ts) with Ethers v6. It signs EIP-712 data, verifies the signature through the VM's `ecrecover` precompile, saves `MonadTypedData.json`, and submits an opcode transaction. Monad Next succeeds and stores `1`; Monad Ten reverts and preserves `42`. Copy either script's transaction hash into the debugger to inspect the recorded execution.

Right-click `MonadTypedData.json` in the file explorer and choose **Sign Typed Data** to sign the same payload with the selected account. `eth_signTypedData_v4` accepts an object or JSON string; `eth_signTypedData` is a v4 alias. Payloads must include `types`, an `EIP712Domain` type definition, `primaryType`, `domain`, and `message`. Signing uses Remix's existing v4 signing library and preserves the supplied domain, including its chain ID.

Message signing through `personal_sign` and `eth_sign` also works. Signing does not execute a transaction or change VM state. Imported account keys remain available after save/restore.
