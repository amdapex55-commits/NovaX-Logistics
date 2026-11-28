# Play Console: what to paste where (28 Nov 2026)

App: **NovaX: COD Courier Pakistan** · package `com.novaxlogistics.app` · version 1.0.0 (code 1) · targets Android 16 / API 36.
Upload: `native/android/app/build/outputs/bundle/release/app-release.aab` (signed with the upload key in `~/.novax/novax-upload.jks`; keep that file and its password backed up. Lose it and you need Google support to reset the upload key).
Choose **Play App Signing** (Google holds the app signing key). After the first upload, copy the **App signing key SHA-1 and SHA-256** from Play Console → Setup → App signing into Firebase → Project settings → NovaX Android → Add fingerprint.
Listing text, data safety, age rating: `listing.md`. Screenshots: `screenshots/`. Feature graphic: `feature-graphic.png`. Icon: `icon-512.png`.

## Before production: closed testing
New personal developer accounts must run a closed test with at least 12 testers for 14 days before production access. An organisation account (with D-U-N-S) skips this.

## App access (reviewers need this)
Choose **All or some functionality is restricted** and paste:

> NovaX is a cash-on-delivery courier for online stores in Pakistan. The app opens on its front page.
> 1. **Track** (no account): enter tracking number **(review AWB)** and tap Track parcel. It shows the parcel's live status.
> 2. **Look around without an account**: tap **Ship**, then **See the portal first, no signup**. This is a demo merchant with sample parcels, wallet and reports. Saving is switched off in the demo.
> 3. **Merchant sign-in**: tap **Log in** with the review login below. It is a real test merchant kept apart from real customers. You can book a parcel (it is cancelled by our team, no rider is sent), print or share its label, see the wallet and reports, open a support ticket and request account deletion.
> 4. **Rider side**: riders are NovaX staff and sign in with logins NovaX gives them, so it is not open to the public.
>
> Merchant review login: (email) / (password)

Login to paste (Aisha): create one merchant account for reviewers (e.g. a Gmail you own), let it in from Admin → Signup queue, and note it in `~/.novax/review-login.env`. Do not give it a bank account or CNIC.

## Ads
No.

## Content rating
See `listing.md` → Age rating.

## Target audience
18 and over only.

## News / COVID / Government / Health
No / No / No / No.

## Financial features
Choose **None of the above** if Play's list doesn't fit; if asked, explain: "The app shows merchants the cash-on-delivery money NovaX collected for them and lets them ask for a bank transfer of it. NovaX is not a bank or wallet licence holder; there are no loans, payments to other people, crypto or investments."

## Data safety
Copy the table in `listing.md`. Account deletion URL: **https://novaxlogistics.com/delete-account**. Privacy policy: **https://novaxlogistics.com/privacy**.

## Sensitive permissions (App content)
- Location (`ACCESS_FINE_LOCATION`, foreground only): **NovaX riders only**. When a rider records a parcel action (picked up, delivered, refused) the app saves where it happened, so merchants can trust the record. No background location.
- Camera: scan tracking numbers; photograph the CNIC (merchants, for payouts).
- Microphone (`RECORD_AUDIO`): riders record a short voice note when a customer refuses a parcel or cannot be reached.
- Notifications (`POST_NOTIFICATIONS`): asked once after a merchant signs in, never at first launch.

## Crashes and freezes
Play Console → Quality → **Android vitals** shows crashes and ANRs for free once the app is live. The release gate is crash-free sessions ≥ 99.5%.

## Before you upload: decide these first (from the 28 Nov review)
- 64 Fingerprint / Face ID re-entry (needs a new native plugin, so it only ships in a store build)
- 59 Delivery alerts for customers (needs a new backend)
- 90 New wallet screen design
- 77 Map pin for the address
- 81, 89 Ship launcher / direct Wallet (mostly moot now)
- Rider push notifications (no backend yet)
- 45 Paste reads the clipboard only on tap (phones ask permission otherwise)
