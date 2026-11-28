# App Store Connect: what to paste where (28 Nov 2026)

App: **NovaX: COD Courier Pakistan** · bundle id `com.novaxlogistics.app` · version 1.0.0 (build 1) · iOS 15 and later · iPhone only.
Listing text, keywords, age rating, privacy label: `listing.md`. Screenshots: `screenshots-ios/` (6.9", 1290×2796).

## What Apple needs before submitting (Aisha)
1. Apple Developer Program account (organisation needs D-U-N-S; personal is faster).
2. Xcode → App target → Signing & Capabilities → Team. **Push Notifications** is already in `App.entitlements`; Xcode adds the App ID capability.
3. Apple Developer → Keys → new key with **Apple Push Notifications service** → download the `.p8` → Firebase → Project settings → Cloud Messaging → NovaX iOS → upload it with its Key ID and your Team ID.
4. Product → Archive → Distribute App → App Store Connect. Then TestFlight on a real iPhone: sign in, allow notifications, deliver a test parcel and check the alert arrives.
5. Export compliance: already answered in Info.plist (`ITSAppUsesNonExemptEncryption` = NO, only HTTPS).

## App Review Information → Sign-in
Sign-in required: **Yes**. Use the merchant review login (see `play-console.md`).

## App Review Information → Notes (paste)

> NovaX is a cash-on-delivery courier for online stores in Pakistan. Merchants book parcels, print labels, follow deliveries and receive the cash their customers paid.
>
> How to review:
> • Track without an account: on the front page enter tracking number (review AWB) and tap Track parcel.
> • Demo without an account: tap Ship → "See the portal first, no signup". Sample data; saving is switched off.
> • Signed in: tap Log in with the review login. Book a parcel (our team cancels review bookings, no rider is sent), print or share the label, open the wallet and reports, open a support ticket.
>
> About the CNIC: Pakistani law and our payout safety need us to know who owns a merchant account before we send them money. The owner adds a photo of the front and back of their CNIC (national ID) in Profile. Only the owner and NovaX staff can see it; it is deleted with the account. A reviewer does not need to add one.
>
> About the COD wallet: when a customer pays the rider cash on delivery, NovaX holds that money for the merchant and shows it in the Money tab. The merchant asks for a bank transfer of their own money; fees are flat rupee amounts shown before they confirm. There are no in-app purchases, no digital goods and no payments between users. NovaX earns from delivery charges, which merchants are invoiced for.
>
> Riders: NovaX riders are staff and sign in with logins we issue. The app records their location only when they mark a parcel action, and they can record a voice note when a customer refuses a parcel. Merchants never use location or the microphone.
>
> Notifications tell a merchant when a parcel is picked up, delivered, refused or returned and when a payout is sent. Asked once after sign-in.
>
> Account deletion: Profile → Delete your NovaX account → Ask to delete my account, or https://novaxlogistics.com/delete-account.
> Support: https://novaxlogistics.com/support · support@novaxlogistics.com · WhatsApp +92 312 3922558.

## Guideline 4.2 (minimum functionality)
The app is the merchant portal in a native shell. Native parts to point at if Apple asks: push notifications, native print and share sheet for labels, camera scanning, haptics on booking, offline screen, and the app-only front page and launch screen.
