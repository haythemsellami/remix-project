// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract HistoricalCalls {
    uint256 public value;
    event Updated(uint256 value);
    error Rejected(uint256 previous);

    function store(uint256 next) public {
        value = next;
        emit Updated(next);
    }

    function read() public view returns (uint256 stored, uint256 number, uint256 timestamp, bytes32 parent) {
        return (value, block.number, block.timestamp, blockhash(block.number - 1));
    }

    function simulate(uint256 expected, uint256 next) public returns (uint256, uint256, uint256, bytes32) {
        require(value == expected, "Unexpected historical state");
        value = next;
        emit Updated(next);
        return read();
    }

    function reject() public {
        uint256 previous = value;
        value = 99;
        revert Rejected(previous);
    }

    function requireContext(uint256 number, uint256 timestamp, bytes32 parent) public view returns (uint256) {
        require(block.number == number && block.timestamp == timestamp && blockhash(block.number - 1) == parent, "Unexpected block context");
        return value;
    }
}
