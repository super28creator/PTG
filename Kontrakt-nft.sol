// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * Phrase To Guess — ERC-721 (jeden plik, bez importów z GitHuba/npm).
 * Łatwa weryfikacja na Basescan: wklej ten sam plik (Contract verification → Solidity single file).
 *
 * Remix: 0.8.30, optimization on, EVM paris.
 * Mint publiczny: `mint()` + opłata `mintPriceWei` (bez podpisu / bez serwera).
 * Ostatni argument konstruktora `uniformTokenURI_`: niepusty = ten sam JSON IPFS dla każdego tokena
 * (nieskończony mint „jednej” grafiki); wtedy `baseUri_` może być pusty `""`.
 */

/* ======================== Interfaces ======================== */

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    function balanceOf(address owner) external view returns (uint256 balance);
    function ownerOf(uint256 tokenId) external view returns (address owner);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address operator);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

interface IERC721Metadata is IERC721 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/* ======================== Libraries ======================== */

library Strings {
    function toString(uint256 value) internal pure returns (string memory str) {
        if (value == 0) return "0";
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

/* ======================== ReentrancyGuard ======================== */

abstract contract ReentrancyGuard {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

/* ======================== Ownable ======================== */

abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableInvalidOwner(address owner);
    error OwnableUnauthorizedAccount(address account);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function owner() public view returns (address) {
        return _owner;
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function _checkOwner() internal view {
        if (owner() != msg.sender) revert OwnableUnauthorizedAccount(msg.sender);
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

/* ======================== EIP-712 (minimal) ======================== */

abstract contract EIP712 {
    bytes32 private immutable _HASHED_NAME;
    bytes32 private immutable _HASHED_VERSION;
    bytes32 private immutable _INITIAL_DOMAIN_SEPARATOR;
    uint256 private immutable _INITIAL_CHAIN_ID;
    address private immutable _INITIAL_THIS;

    constructor(string memory name, string memory version) {
        _HASHED_NAME = keccak256(bytes(name));
        _HASHED_VERSION = keccak256(bytes(version));
        _INITIAL_CHAIN_ID = block.chainid;
        _INITIAL_THIS = address(this);
        _INITIAL_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    function _domainSeparator() private view returns (bytes32) {
        if (address(this) == _INITIAL_THIS && block.chainid == _INITIAL_CHAIN_ID) {
            return _INITIAL_DOMAIN_SEPARATOR;
        }
        return _computeDomainSeparator();
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                _HASHED_NAME,
                _HASHED_VERSION,
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", _domainSeparator(), structHash));
    }
}

/* ======================== ERC721 (minimal, metadata) ======================== */

abstract contract ERC721 is IERC721Metadata, EIP712 {
    using Strings for uint256;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    string private _name;
    string private _symbol;

    mapping(uint256 tokenId => address) private _owners;
    mapping(address owner => uint256) private _balances;
    mapping(uint256 tokenId => address) private _tokenApprovals;
    mapping(address owner => mapping(address operator => bool)) private _operatorApprovals;

    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner);
    error ERC721InvalidSender(address sender);
    error ERC721InvalidReceiver(address receiver);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error ERC721InvalidOperator(address operator);

    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant ERC721_METADATA_INTERFACE_ID = 0x5b5e139f;
    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;

    constructor(string memory name_, string memory symbol_, string memory eip712Name, string memory eip712Version)
        EIP712(eip712Name, eip712Version)
    {
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID || interfaceId == ERC721_INTERFACE_ID
            || interfaceId == ERC721_METADATA_INTERFACE_ID;
    }

    function balanceOf(address owner) public view returns (uint256) {
        if (owner == address(0)) revert ERC721InvalidOwner(address(0));
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        return _requireOwned(tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        _requireOwned(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 tokenId) public {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender)) {
            revert ERC721InvalidApprover(msg.sender);
        }
        _approve(to, tokenId, msg.sender);
    }

    function setApprovalForAll(address operator, bool approved) public {
        if (operator == address(0)) revert ERC721InvalidOperator(operator);
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        address owner = _requireOwned(tokenId);
        if (from != owner) revert ERC721IncorrectOwner(from, tokenId, owner);
        if (!_isAuthorized(owner, msg.sender, tokenId)) revert ERC721InsufficientApproval(msg.sender, tokenId);
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            if (retval != IERC721Receiver.onERC721Received.selector) {
                revert ERC721InvalidReceiver(to);
            }
        }
    }

    function tokenURI(uint256 tokenId) public view virtual returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(_baseURI(), tokenId.toString()));
    }

    function _baseURI() internal view virtual returns (string memory) {
        return "";
    }

    function _ownerOf(uint256 tokenId) internal view returns (address) {
        return _owners[tokenId];
    }

    function _requireOwned(uint256 tokenId) internal view returns (address) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
        return owner;
    }

    function _isAuthorized(address owner, address spender, uint256 tokenId) internal view returns (bool) {
        return spender == owner || isApprovedForAll(owner, spender) || getApproved(tokenId) == spender;
    }

    function _approve(address to, uint256 tokenId, address auth) internal {
        address owner = _requireOwned(tokenId);
        if (auth != owner && !isApprovedForAll(owner, auth)) revert ERC721InvalidApprover(auth);
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        address owner = _requireOwned(tokenId);
        if (from != owner) revert ERC721IncorrectOwner(from, tokenId, owner);
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        _tokenApprovals[tokenId] = address(0);
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _mint(address to, uint256 tokenId) internal {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        if (_ownerOf(tokenId) != address(0)) revert ERC721InvalidSender(address(0));
        unchecked {
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _safeMint(address to, uint256 tokenId) internal {
        _mint(to, tokenId);
        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, address(0), tokenId, "");
            if (retval != IERC721Receiver.onERC721Received.selector) {
                revert ERC721InvalidReceiver(to);
            }
        }
    }
}

/* ======================== PhraseToGuess NFT ======================== */

contract PhraseToGuessNFT is ERC721, Ownable, ReentrancyGuard {
    uint256 private _nextTokenId;
    string private _baseUri;
    /** Jeśli niepusty, każdy token zwraca ten sam tokenURI (jeden plik IPFS — nieskończony mint tej samej grafiki). */
    string private _uniformTokenURI;
    uint256 public immutable mintPriceWei;
    uint256 public immutable maxSupply;

    error InvalidBaseURI();
    error InvalidMintPrice();
    error InsufficientPayment(uint256 required, uint256 sent);
    error SoldOut();
    error WithdrawFailed();
    error RefundFailed();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory baseUri_,
        uint256 mintPriceWei_,
        uint256 maxSupply_,
        address initialOwner,
        string memory uniformTokenURI_
    ) ERC721(name_, symbol_, "PhraseToGuess", "1") Ownable(initialOwner) {
        if (mintPriceWei_ == 0) revert InvalidMintPrice();

        if (bytes(uniformTokenURI_).length > 0) {
            _uniformTokenURI = uniformTokenURI_;
            _baseUri = "";
        } else {
            if (bytes(baseUri_).length == 0) revert InvalidBaseURI();
            bytes memory b = bytes(baseUri_);
            if (b[b.length - 1] != bytes1("/")) revert InvalidBaseURI();
            _baseUri = baseUri_;
            _uniformTokenURI = "";
        }

        mintPriceWei = mintPriceWei_;
        maxSupply = maxSupply_;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseUri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (bytes(_uniformTokenURI).length > 0) {
            return _uniformTokenURI;
        }
        return super.tokenURI(tokenId);
    }

    function mint() external payable nonReentrant {
        if (msg.value < mintPriceWei) {
            revert InsufficientPayment(mintPriceWei, msg.value);
        }

        address minter = msg.sender;
        uint256 id = _nextTokenId;
        if (maxSupply != 0 && id >= maxSupply) revert SoldOut();
        unchecked {
            _nextTokenId = id + 1;
        }
        _safeMint(minter, id);

        uint256 refund = msg.value - mintPriceWei;
        if (refund > 0) {
            (bool ok,) = payable(minter).call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    function withdraw() external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok,) = payable(owner()).call{value: bal}("");
        if (!ok) revert WithdrawFailed();
    }
}
