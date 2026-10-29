// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PrecompileCalls {
    uint256 public value = 10;
    bytes public result;
    bool public lastSuccess;

    error PrecompileFailed(address target);
    event PrecompileResult(bool success, bytes output);

    function runPrecompile(address target, bytes memory input, uint256 gasLimit)
        public returns (bool, bytes memory)
    {
        return _run(target, input, gasLimit, false);
    }

    function hashAndStore() external returns (bool, bytes memory) {
        return _run(address(2), hex"616263", 72, true);
    }

    function verifyP256() external returns (bool, bytes memory) {
        // P-256 known-answer vector from revm-precompile's secp256r1 tests.
        bytes memory input = hex"4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4da73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d604aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff37618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e";
        return _run(address(0x100), input, 6900, true);
    }

    function invalidPoint() external returns (bool, bytes memory) {
        return _run(address(6), abi.encode(uint256(1), uint256(3), uint256(0), uint256(0)), 1000, false);
    }

    function insufficientGas() external returns (bool, bytes memory) {
        return _run(address(2), hex"616263", 71, false);
    }

    function requireValidPoint() external returns (bool, bytes memory) {
        value = 99;
        emit PrecompileResult(true, hex"99");
        return _run(address(6), abi.encode(uint256(1), uint256(3), uint256(0), uint256(0)), 1000, true);
    }

    function _run(address target, bytes memory input, uint256 gasLimit, bool required)
        private returns (bool success, bytes memory output)
    {
        (success, output) = target.staticcall{gas: gasLimit}(input);
        if (required && !success) revert PrecompileFailed(target);
        lastSuccess = success;
        result = output;
        value = success ? 42 : 11;
        emit PrecompileResult(success, output);
    }
}
