// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library LinkedValues {
    function increment(uint256 input) external pure returns (uint256) {
        return input + 1;
    }
}

contract FactoryChild {
    uint256 public value;
    address public creator;
    error ConstructorRejected(uint256 initial);
    event ValueChanged(uint256 value);

    constructor(uint256 initial, bool reject) payable {
        value = initial;
        creator = msg.sender;
        emit ValueChanged(initial);
        if (reject) revert ConstructorRejected(initial);
    }

    function storeWithLibrary(uint256 next) external {
        value = LinkedValues.increment(next);
        emit ValueChanged(value);
    }
}

contract FactoryDeployments {
    address public lastChild;
    event Created(address indexed child);
    event CreationFailed(bytes reason);

    function create(uint256 initial) external payable returns (address) {
        lastChild = address(new FactoryChild{value: msg.value}(initial, false));
        emit Created(lastChild);
        return lastChild;
    }

    function create2(bytes32 salt, uint256 initial) external payable returns (address) {
        lastChild = address(new FactoryChild{salt: salt, value: msg.value}(initial, false));
        emit Created(lastChild);
        return lastChild;
    }

    function rejectCreate2(bytes32 salt) external payable {
        try new FactoryChild{salt: salt, value: msg.value}(99, true) returns (FactoryChild) {
            revert("constructor should reject");
        } catch (bytes memory reason) {
            emit CreationFailed(reason);
        }
    }
}
