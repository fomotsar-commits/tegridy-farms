/**
 * Wallet marks shared by the EVM and Solana connect modals.
 *
 * This module holds STRINGS ONLY and imports nothing — that is the whole
 * point. `rainbowkitWallets.ts` pulls in wagmi and RainbowKit at module
 * scope, so the Solana chunk must never import it; and duplicating a data URI
 * in two files is how the two modals end up showing different Trust marks a
 * year from now. A dependency-free constants module costs the Solana bundle
 * nothing and keeps one wallet looking like one wallet.
 */

/**
 * Trust Wallet — vendored byte-identical from @rainbow-me/rainbowkit 2.2.11's
 * own icon module (dist/trustWallet-*.js), trailing %0A included. Used by the
 * EVM connect modal (rainbowkitWallets.ts) and the Solana one
 * (solanaWallets.ts).
 */
export const TRUST_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20width%3D%2228%22%20height%3D%2228%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3Cpath%20fill%3D%22%230500FF%22%20d%3D%22M6%207.583%2013.53%205v17.882C8.15%2020.498%206%2015.928%206%2013.345V7.583Z%22%2F%3E%3Cpath%20fill%3D%22url(%23a)%22%20d%3D%22M22%207.583%2013.53%205v17.882c6.05-2.384%208.47-6.954%208.47-9.537V7.583Z%22%2F%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22a%22%20x1%3D%2219.768%22%20x2%3D%2214.072%22%20y1%3D%223.753%22%20y2%3D%2222.853%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%22.02%22%20stop-color%3D%22%2300F%22%2F%3E%3Cstop%20offset%3D%22.08%22%20stop-color%3D%22%230094FF%22%2F%3E%3Cstop%20offset%3D%22.16%22%20stop-color%3D%22%2348FF91%22%2F%3E%3Cstop%20offset%3D%22.42%22%20stop-color%3D%22%230094FF%22%2F%3E%3Cstop%20offset%3D%22.68%22%20stop-color%3D%22%230038FF%22%2F%3E%3Cstop%20offset%3D%22.9%22%20stop-color%3D%22%230500FF%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3C%2Fsvg%3E%0A';

/**
 * MetaMask — vendored byte-identical from @rainbow-me/rainbowkit 2.2.11's own
 * icon module (dist/wallets/walletConnectors/metaMaskWallet-*.js), the mark the
 * EVM connect modal already shows. Used by the Solana connect modal's MetaMask
 * row (solanaWallets.ts), which only appears where MetaMask's own Solana
 * registration has not — the registered wallet brings its own icon.
 */
export const METAMASK_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2228%22%20height%3D%2228%22%20fill%3D%22none%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3Cg%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20fill%3D%22%23ff5c16%22%20d%3D%22m24.024%2023.824-4.846-1.434-3.655%202.172-2.55-.001-3.656-2.171-4.844%201.434L3%2018.88l1.473-5.488L3%208.751%204.473%203l7.569%204.496h4.413L24.024%203l1.473%205.751-1.473%204.64%201.473%205.488z%22%2F%3E%3Cpath%20fill%3D%22%23ff5c16%22%20d%3D%22m4.474%203%207.57%204.499-.302%203.087zm4.844%2015.881%203.33%202.522-3.33.987zm3.064-4.17-.64-4.123-4.097%202.804h-.002v.001l.013%202.886%201.661-1.567zM24.024%203l-7.57%204.499.3%203.087zM19.18%2018.881l-3.33%202.522%203.33.987zm1.674-5.488v-.002zl-4.097-2.804-.64%204.124h3.064l1.662%201.567z%22%2F%3E%3Cpath%20fill%3D%22%23e34807%22%20d%3D%22m9.317%2022.39-4.844%201.434L3%2018.881h6.317zm3.064-7.68.925%205.962-1.282-3.315-4.37-1.078%201.662-1.568zm6.799%207.68%204.844%201.434%201.473-4.943H19.18zm-3.064-7.68-.925%205.962%201.282-3.315%204.37-1.078-1.663-1.568z%22%2F%3E%3Cpath%20fill%3D%22%23ff8d5d%22%20d%3D%22m3%2018.88%201.473-5.489h3.169l.012%202.887%204.37%201.078%201.282%203.314-.659.73-3.33-2.522H3zm22.497%200-1.473-5.489h-3.17l-.01%202.887-4.371%201.078-1.282%203.314.659.73%203.33-2.522h6.317zM16.455%207.495h-4.413l-.3%203.087%201.565%2010.084h1.884l1.565-10.084z%22%2F%3E%3Cpath%20fill%3D%22%23661800%22%20d%3D%22M4.473%203%203%208.751l1.473%204.64h3.169l4.1-2.805zm6.992%2012.908H10.03l-.781.761%202.776.685-.56-1.447M24.024%203l1.473%205.751-1.473%204.64h-3.17l-4.098-2.805zm-6.99%2012.908h1.437l.782.762-2.78.686.56-1.45zm-1.512%206.687.328-1.193-.66-.73h-1.885l-.659.73.327%201.192%22%2F%3E%3Cpath%20fill%3D%22%23c0c4cd%22%20d%3D%22M15.522%2022.594v1.969h-2.548v-1.969z%22%2F%3E%3Cpath%20fill%3D%22%23e7ebf6%22%20d%3D%22m9.318%2022.388%203.658%202.174v-1.969l-.328-1.192zm9.862%200-3.658%202.174v-1.969l.328-1.192z%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M3%203h22.5v21.563H3z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E';
