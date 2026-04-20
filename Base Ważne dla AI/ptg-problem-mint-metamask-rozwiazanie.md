# PhraseToGuess - problem mintu (MetaMask, Base) i rozwiazanie

## Co bylo zle (objawy)

- Po kliknieciu mintu wyskakiwalo wiele takich samych okien transakcji (`tx po tx`).
- Network fee bywalo bardzo wysokie (nawet kilka USD), mimo ze cena mintu byla poprawna.
- Uzytkownik mial wrazenie, ze aplikacja dziala jak na Ethereum Mainnet.

## Prawdziwa przyczyna

- Aplikacja miala wieloetapowy pipeline wysylki transakcji (retry/fallbacky), ktory w niektorych scenariuszach odpalal kolejne requesty `eth_sendTransaction`.
- W czesci przypadkow portfel zwracal hash w innym polu niz oczekiwane, przez co frontend traktowal to jak niepowodzenie i probowal dalej.
- Gaz byl estymowany zbyt wysoko (lub mial za wysoki limit), co zawyzalo L2 fee na Base.

## Co zostalo naprawione

- Dla mintu trofeum (`publicMint`) ustawiono **strict one-shot**:
  - dokladnie 1 wywolanie `eth_sendTransaction`,
  - bez retry,
  - bez fallbackow,
  - bez dodatkowego przebiegu z builder suffix.
- Dodano globalny lock requestu portfela, zeby wykluczyc rownolegle prompt-y.
- Dodano bezpieczne ograniczenie `gas` dla trofeum (clamp), aby nie pompowac fee.
- Usprawniono odczyt hashy transakcji z roznych formatow odpowiedzi portfela.
- Dodano jawna walidacje sieci (`chainId 0x2105` = Base Mainnet) przed wyslaniem tx.

## Efekt po poprawce

- Jeden klik = jeden prompt transakcji.
- Brak petli popupow transakcyjnych.
- Fee wraca do normalnych wartosci dla Base (token gazu to dalej ETH, co jest poprawne na Base).

## Uwaga

- Na Base waluta gazu wyswietla sie jako ETH - to jest poprawne zachowanie.
- Rzeczywisty problem nie byl w cenie mintu, tylko w logice wysylki tx i limicie gazu po stronie frontendu.
