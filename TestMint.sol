// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

contract SimpleMintTest {
    // Zdarzenie wymagane przez standard ERC721, aby BaseScan widział transfery
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    string public name = "PhraseTest";
    string public symbol = "PTT";
    uint256 public totalSupply;
    address public owner;
    
    // Cena ~1$ (Przy kursie ETH ok. 3300$, 0.0003 ETH to ok. 1$). 
    // W razie potrzeby możesz to zmienić przed wdrożeniem.
    uint256 public mintPrice = 0.0003 ether; 

    // Podstawowe mapowania ERC721
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    constructor() {
        owner = msg.sender;
    }

    // Główna funkcja mintowania
    function mint() external payable {
        require(msg.value >= mintPrice, "Wyslij minimum wymagane ETH (~1$)");

        totalSupply++;
        uint256 newItemId = totalSupply;

        balanceOf[msg.sender]++;
        ownerOf[newItemId] = msg.sender;

        // Emitowanie zdarzenia tworzy "ślad" NFT na blockchainie
        emit Transfer(address(0), msg.sender, newItemId);
    }

    // Wypłata zebranych środków dla twórcy kontraktu
    function withdraw() external {
        require(msg.sender == owner, "Tylko wlasciciel moze wyplacic");
        payable(owner).transfer(address(this).balance);
    }

    // Deklaracja kompatybilności (aby portfele i BaseScan rozpoznały to jako NFT)
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f;   // ERC721Metadata
    }

    // Proste URI testowe (wersja bez grafiki)
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "Token nie istnieje");
        return "To jest testowy mint - brak metadanych i grafiki";
    }
}