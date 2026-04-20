# Opóźnienie mintu w Base App (~15 s) — problem i rozwiązanie

## Objaw

Po naciśnięciu **Mint** w aplikacji Base użytkownik czekał ok. **10–15 sekund** (czasem ~5 s po częściowych poprawkach), zanim pojawiła się transakcja / prompt portfela. Oczekiwane zachowanie: **natychmiastowe** pokazanie TX lub szybki prompt (Base jest szybki i tani).

## Przyczyny (w kodzie frontu `index.html` + API na Vercel)

1. **`ensureBaseMainnet` z timeoutem 15 s**  
   Wywoływane było **`wallet_switchEthereumChain`** nawet wtedy, gdy portfel **już był na Base**. W WebView Base część wywołań potrafi „wisieć” aż do **pełnego timeoutu** — dokładnie ~**15 s**.

2. **Sekwencyjne zapytania do proxy RPC (`/api/base-jsonrpc`)**  
   Przy błędzie/wolnym pierwszym URL-u kod **czekał po kolei** (np. 10 s × kilka hostów), zamiast brać **pierwszą udaną** odpowiedź.

3. **Ciężkie rzeczy przed wysłaniem TX**  
   - `readMintPriceWeiHex` + `readNftBalanceBn` blokowały ścieżkę **przed** `eth_sendTransaction`.  
   - **`eth_requestAccounts`** przy każdym mincie zamiast najpierw **`eth_accounts`** (bez promptu).  
   - **`await update(...)`** w RTDB (`mintWalletForMint`) blokował mint przy linkowaniu portfela.

4. **UI czekało na receipt** zanim pokazało TX (później poprawione callbackiem `onTxHash` dla trofeum).

## Działania naprawcze (skrót)

| Zmiana | Cel |
|--------|-----|
| **`eth_chainId` z krótkim timeoutem** → jeśli już Base 8453, **wyjście bez** `wallet_switchEthereumChain` | Usunąć zbędne ~15 s |
| **`baseJsonRpc` + `postBroadcastMintRaw` + voucher** → **równoległe** (`Promise.any` / `ptgPromiseAny`) + krótsze timeouty | Pierwsza szybka odpowiedź zamiast kolejki URL-i |
| **`getWalletAccountsFast`**: najpierw `eth_accounts` (szybko), dopiero potem `eth_requestAccounts` | Mniej czekania przy już podłączonym portfelu |
| **`Promise.all([ensureBaseMainnet, getWalletAccountsFast])`** | Brak szeregu dwóch wolnych kroków |
| **Cache ceny `priceWei` w `sessionStorage`** (TTL ~45 min) | Kolejne minty bez odczytu RPC |
| **`void update(...)`** dla `mintWalletForMint` | Mint nie czeka na Firebase |
| **Trofeum: bez sztucznego `gas` przed `eth_sendTransaction`** (wcześniej) | Mniej RPC przed promptem |
| Wcześniejszy **`onTxHash`** + status „Tx sent” | Link do Basescan od razu po hash |

## Ograniczenia

- **Pierwszy mint w sesji** nadal może zrobić jeden odczyt ceny z kontraktu (lub voucher dla odznak) — inaczej ryzykujemy złą **`msg.value`**.
- **Czas samego UI podpisu w Base / Coinbase Wallet** zależy od portfela, nie w 100% od frontu.

## Pliki

- Głównie: `index.html` (logika mintu, RPC, portfel, cache).
- API: `api/base-jsonrpc.js`, `api/ptg-broadcast-mint.js` (serwerowe proxy RPC / wysyłka raw tx).

---

*Dokumentacja dla AI / zespołu — PhraseToGuess, Base.*
