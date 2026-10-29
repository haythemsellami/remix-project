// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "remix_tests.sol";
import "remix_accounts.sol";
import "hardhat/console.sol";

contract MonadUnitTest {
    uint256 public value;
    address public oracle;

    function beforeAll() public {
        bytes memory code = hex"6009600c60003960096000f3ae005f5260205ff3";
        address deployed;
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "oracle deployment failed");
        oracle = deployed;
    }

    function beforeEach() public { value = 41; }
    function afterEach() public { require(value >= 41, "afterEach state"); }

    function testStore() public {
        value = value + 1;
        console.log("monad-store", value, true, msg.sender);
        Assert.equal(value, 42, "setup and storage write");
    }

    function testAssertionFailure() public {
        console.log("monad-assertion");
        Assert.equal(value, 99, "intentional assertion failure");
    }

    function testRevert() public {
        console.log("monad-revert");
        revert("intentional revert");
    }

    function testReadOnly() public view returns (bool) {
        console.log("monad-view", value);
        return value == 41;
    }

    function testReadOnlyFailure() public view returns (bool) {
        console.log("monad-view-failure");
        return false;
    }

    /// #sender: account-1
    /// #value: 7
    function testSenderAndValue() public payable {
        Assert.equal(msg.sender, TestsAccounts.getAccount(1), "selected sender");
        Assert.equal(msg.value, 7, "supplied value");
    }

    function testMonadOpcode() public {
        (bool ok, bytes memory data) = oracle.staticcall{gas: 100000}("");
        require(ok, "Monad opcode rejected");
        Assert.equal(abi.decode(data, (uint256)), 1, "nested Monad call depth");
    }
}
