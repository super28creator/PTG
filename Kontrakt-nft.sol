// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/*
  PhraseToGuess NFT — ERC-721 (single file, jak weryfikacja na Basescan).
  - owner: mintTo(to, tokenURI), setPrice, withdraw(to)
  - każdy: publicMint(tokenURI) payable (msg.value >= priceWei; nadpłata wraca)
  - ReentrancyGuard na publicMint / withdraw
  Cena w wei: ~1¢ przy ~$3.3k/ETH → 3_000_000_000_000 (0.000003 ETH), NIE 3_000_000_000_000_000 (0.003 ETH).
*/

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) external view returns (uint256 balance);
    function ownerOf(uint256 tokenId) external view returns (address owner);

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;

    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address operator);

    function setApprovalForAll(address operator, bool _approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Metadata is IERC721 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

abstract contract Ownable {
    address private _owner;
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), _owner);
    }

    function owner() public view returns (address) {
        return _owner;
    }

    modifier onlyOwner() {
        require(owner() == msg.sender, "Ownable: caller is not the owner");
        _;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "Ownable: zero");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

library Strings {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

abstract contract ERC165 is IERC165 {
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IERC165).interfaceId;
    }
}

contract PhraseToGuessNFT is ERC165, IERC721Metadata, Ownable, ReentrancyGuard {
    using Strings for uint256;

    string private _name;
    string private _symbol;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;

    uint256 public nextTokenId;
    uint256 public priceWei;

    event Minted(address indexed to, uint256 tokenId, string tokenURI);

    constructor(string memory name_, string memory symbol_, uint256 _priceWei) {
        _name = name_;
        _symbol = symbol_;
        priceWei = _priceWei;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IERC721).interfaceId || interfaceId == type(IERC721Metadata).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function name() external view override returns (string memory) {
        return _name;
    }

    function symbol() external view override returns (string memory) {
        return _symbol;
    }

    function balanceOf(address ownerAddr) public view returns (uint256) {
        require(ownerAddr != address(0), "ERC721: balance query zero");
        return _balances[ownerAddr];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address ownerAddr = _owners[tokenId];
        require(ownerAddr != address(0), "ERC721: owner query nonexist");
        return ownerAddr;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "ERC721Metadata: URI query for nonexistent token");
        return _tokenURIs[tokenId];
    }

    function approve(address to, uint256 tokenId) external override {
        address ownerAddr = ownerOf(tokenId);
        require(to != ownerAddr, "ERC721: approval to current owner");
        require(
            msg.sender == ownerAddr || isApprovedForAll(ownerAddr, msg.sender),
            "ERC721: approve caller not owner nor approved for all"
        );
        _tokenApprovals[tokenId] = to;
        emit Approval(ownerAddr, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view override returns (address) {
        require(_exists(tokenId), "ERC721: approved query for nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external override {
        require(operator != msg.sender, "ERC721: approve to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address ownerAddr, address operator) public view override returns (bool) {
        return _operatorApprovals[ownerAddr][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        require(_isApprovedOrOwner(msg.sender, tokenId), "ERC721: transfer caller not owner nor approved");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external override {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "ERC721: transfer caller not owner nor approved");
        _safeTransfer(from, to, tokenId, data);
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        require(_exists(tokenId), "ERC721: operator query for nonexistent token");
        address ownerAddr = ownerOf(tokenId);
        return (spender == ownerAddr || getApproved(tokenId) == spender || isApprovedForAll(ownerAddr, spender));
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(ownerOf(tokenId) == from, "ERC721: transfer from incorrect owner");
        require(to != address(0), "ERC721: transfer to zero");

        _approve(address(0), tokenId);

        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function _safeTransfer(address from, address to, uint256 tokenId, bytes memory data) internal {
        _transfer(from, to, tokenId);
        require(_checkOnERC721Received(from, to, tokenId, data), "ERC721: transfer to non ERC721Receiver");
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data)
        private
        returns (bool)
    {
        if (isContract(to)) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                return retval == IERC721Receiver.onERC721Received.selector;
            } catch (bytes memory) {
                return false;
            }
        } else {
            return true;
        }
    }

    function _mint(address to, uint256 tokenId) internal {
        require(to != address(0), "ERC721: mint to zero");
        require(!_exists(tokenId), "ERC721: token already minted");

        _owners[tokenId] = to;
        _balances[to] += 1;

        emit Transfer(address(0), to, tokenId);
    }

    function _safeMint(address to, uint256 tokenId, string memory uri) internal {
        _mint(to, tokenId);
        _setTokenURI(tokenId, uri);
        require(_checkOnERC721Received(address(0), to, tokenId, ""), "ERC721: transfer to non ERC721Receiver");
    }

    function _setTokenURI(uint256 tokenId, string memory uri) internal {
        require(_exists(tokenId), "ERC721URIStorage: URI set of nonexistent token");
        _tokenURIs[tokenId] = uri;
    }

    function _approve(address to, uint256 tokenId) internal {
        _tokenApprovals[tokenId] = to;
        emit Approval(ownerOf(tokenId), to, tokenId);
    }

    function isContract(address account) internal view returns (bool) {
        return account.code.length > 0;
    }

    function mintTo(address to, string memory tokenURI_) public onlyOwner returns (uint256) {
        uint256 tokenId = nextTokenId;
        nextTokenId += 1;
        _safeMint(to, tokenId, tokenURI_);
        emit Minted(to, tokenId, tokenURI_);
        return tokenId;
    }

    function publicMint(string memory tokenURI_) external payable nonReentrant returns (uint256) {
        require(msg.value >= priceWei, "Insufficient payment");
        uint256 tokenId = nextTokenId;
        nextTokenId += 1;
        _safeMint(msg.sender, tokenId, tokenURI_);
        emit Minted(msg.sender, tokenId, tokenURI_);

        uint256 paid = msg.value;
        if (paid > priceWei) {
            uint256 refundAmt = paid - priceWei;
            (bool okRefund,) = payable(msg.sender).call{value: refundAmt}("");
            require(okRefund, "Refund failed");
        }
        return tokenId;
    }

    function withdraw(address payable to) external onlyOwner nonReentrant {
        require(to != address(0), "Withdraw to zero");
        uint256 bal = address(this).balance;
        (bool ok,) = to.call{value: bal}("");
        require(ok, "Withdraw failed");
    }

    function setPrice(uint256 _priceWei) external onlyOwner {
        priceWei = _priceWei;
    }

    /** Naprawa zepsutego tokenURI (np. martwy IPFS) — tylko owner. */
    function setTokenURI(uint256 tokenId, string memory newUri) external onlyOwner {
        require(_exists(tokenId), "nonexistent token");
        _setTokenURI(tokenId, newUri);
    }
}
