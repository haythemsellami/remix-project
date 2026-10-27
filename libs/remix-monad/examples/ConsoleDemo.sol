// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "hardhat/console.sol";

contract ConsoleDemo {
    uint256 public value;

    function logValues() public {
        value = 42;
        console.log("monad-terminal", value, true, msg.sender);
    }
}
