// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ContentRegistry {
    struct ContentRecord {
        bytes32 contentHash;
        address creatorWallet;
        uint256 citationPrice;
        uint256 timestamp;
    }

    mapping(bytes32 => ContentRecord) public registry;

    event ContentRegistered(
        bytes32 indexed contentHash,
        address indexed creatorWallet,
        uint256 citationPrice,
        uint256 timestamp
    );

    function registerContent(
        bytes32 contentHash,
        address creatorWallet,
        uint256 citationPrice
    ) external {
        require(registry[contentHash].timestamp == 0, "Content already registered");
        registry[contentHash] = ContentRecord({
            contentHash: contentHash,
            creatorWallet: creatorWallet,
            citationPrice: citationPrice,
            timestamp: block.timestamp
        });
        emit ContentRegistered(contentHash, creatorWallet, citationPrice, block.timestamp);
    }
}
