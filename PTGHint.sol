// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title PTGHint
 * @dev Smart contract for purchasing hints in the PTG mini-app on Base Mainnet.
 */
contract PTGHint {
    address public owner;
    uint256 public hintPrice;

    // Events for frontend integration
    event HintPurchased(address indexed player, uint256 amountPaid);
    event PriceUpdated(uint256 newPrice);

    constructor(uint256 _initialPriceInWei) {
        owner = msg.sender;
        hintPrice = _initialPriceInWei;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Caller is not the owner");
        _;
    }

    /**
     * @dev Allows users to purchase a hint by sending ETH.
     */
    function buyHint() external payable {
        require(msg.value >= hintPrice, "Insufficient ETH sent for hint");
        
        emit HintPurchased(msg.sender, msg.value);
    }

    /**
     * @dev Updates the price of a single hint.
     * @param _newPrice The new price in Wei.
     */
    function updatePrice(uint256 _newPrice) external onlyOwner {
        hintPrice = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    /**
     * @dev Withdraws all collected funds to the owner's address.
     */
    function withdraw() external onlyOwner {
        uint256 contractBalance = address(this).balance;
        require(contractBalance > 0, "No funds available for withdrawal");
        
        (bool success, ) = owner.call{value: contractBalance}("");
        require(success, "Transfer failed");
    }

    /**
     * @dev Transfer ownership to a new address.
     */
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "New owner is the zero address");
        owner = _newOwner;
    }
}