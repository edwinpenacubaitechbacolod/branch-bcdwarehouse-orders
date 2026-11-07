# Branch Orders Management System

A blue-and-white rebuild starter for branch ordering and warehouse operations.

## Confirmed business rules

1. Branch orders are automatically approved after server-side validation.
2. Inventory is deducted at approval time.
3. Insufficient stock blocks approval; no partial deduction is performed.
4. Warehouse personnel confirms delivery and completes the order.
5. Stock/order mutations are performed by Cloud Functions, not trusted to the browser.

## Included in this starter

- Responsive blue-and-white web interface.
- Firebase Authentication sign-in.
- Role-aware navigation for `branch`, `warehouse`, and `admin`.
- Branch order submission using a callable Cloud Function.
- Atomic automatic approval, stock deduction, stock movement, and order-number generation.
- Warehouse order status progression: Approved → Preparing → Ready for Dispatch → Shipped → Completed.
- Warehouse delivery confirmation.
- Inventory balance view.
- Firestore security rules.
- Admin-only inventory adjustment callable function.
- Automatic email notification to `edwinpenacuba.itechbacolod@gmail.com` after a successful branch order.

## Important scope note

This is a working foundation/MVP scaffold, not a production deployment. It does not yet include the complete admin UI for creating users/products/branches, editing product catalogs, detailed report exports, email templates, or dispatch document printing. Those should be added after the Firebase project is configured and the core workflow is tested.

## 1. Create/configure Firebase

Create a Firebase project and enable:
- Authentication → Email/Password
- Cloud Firestore
- Cloud Functions
- Firebase Hosting

Add a Firebase Web App and copy its configuration into `public/app.js`.
Do not put service-account credentials or private keys in the browser.

## 2. Install and deploy

Install Node.js 20 and Firebase CLI, then run from this project directory:

```bash
npm install -g firebase-tools
firebase login
cd functions
npm install
cd ..
firebase use --add
firebase deploy --only firestore:rules,functions,hosting
```

For production, configure billing/plan requirements for Cloud Functions and review region selection before deployment.

## 3. Configure automatic order emails

The project sends a notification to **edwinpenacuba.itechbacolod@gmail.com** whenever a new order document is created successfully.

This uses SMTP from a trusted Cloud Function. For Gmail, create an App Password for the sending Gmail account (2-Step Verification must be enabled). Do not use your normal Gmail password and do not put credentials in `public/app.js`.

From the project directory, set the SMTP secrets (replace the example values with your actual mail-provider settings):

```bash
firebase functions:secrets:set SMTP_HOST
# Enter: smtp.gmail.com

firebase functions:secrets:set SMTP_PORT
# Enter: 465

firebase functions:secrets:set SMTP_USER
# Enter: the Gmail address used to send notifications

firebase functions:secrets:set SMTP_PASS
# Enter: that account's 16-character Google App Password

cd functions
npm install
cd ..
firebase deploy --only functions
```

For Gmail, use `smtp.gmail.com` and port `465`. The sender account can be different from the notification recipient. The recipient is currently configured in `functions/index.js` as `edwinpenacuba.itechbacolod@gmail.com`.

After deployment, submit a test order with a branch account and check the recipient inbox and spam folder. The notification is sent only after the order is successfully created; insufficient-stock submissions do not generate an order email. Cloud Functions deployment requires a Firebase project with billing enabled where required.

## 4. Create initial data

Create a user in Firebase Authentication, then create `users/{AUTH_UID}` in Firestore.

Example user profile:

```json
{
  "displayName": "Warehouse Administrator",
  "email": "admin@example.com",
  "role": "admin",
  "active": true
}
```

Supported roles:
- `branch`
- `warehouse`
- `admin`

Create branch documents, for example `branches/itech_bacolod`:

```json
{
  "name": "ITECH BACOLOD",
  "active": true
}
```

Create a branch user's profile with a matching `branchId`:

```json
{
  "displayName": "ITECH Bacolod Staff",
  "email": "branch@example.com",
  "role": "branch",
  "branchId": "itech_bacolod",
  "active": true
}
```

Create product documents, for example `products/straw`:

```json
{
  "name": "Straw",
  "unit": "roll",
  "stock": 500,
  "minimumStock": 100,
  "active": true
}
```

Repeat for the original product list:
- Straw (roll)
- Newsprint (bundle)
- POS Thermal Paper (qty)
- Half-Size Cling Wrap (roll)
- Clear Tape (qty)
- Brown Tape (qty)
- Eco Bag - Small (qty)
- Eco Bag - Medium (qty)
- Eco Bag - Large (qty)
- Eco Bag - XL (qty)

Create `system/orderCounter` with `{ "value": 0 }`, or let the first successful order initialize it.

## 5. Firestore collections

- `users`
- `branches`
- `products`
- `orders`
- `stock_movements`
- `audit_logs`
- `system`

## 6. Test before real use

Use a Firebase staging project and test:
- Branch A cannot read Branch B orders.
- Branch users cannot directly create/update orders in Firestore.
- Non-warehouse users cannot update statuses.
- Insufficient stock blocks the entire order.
- Simultaneous orders cannot oversell stock.
- A successful order is automatically approved and deducts stock exactly once.
- Only warehouse/admin can move an order through fulfillment.
- Only warehouse/admin can confirm delivery.
- Inventory adjustments require admin authorization and a reason.

## 7. Existing data migration

Before replacing the old live app:
1. Export/back up the existing `orders` collection.
2. Map old branch names to stable branch IDs.
3. Preserve old order numbers, item quantities, notes, timestamps, and status history where available.
4. Import into a staging Firestore project.
5. Verify record counts and sample orders.
6. Switch production only after sign-off.

## Security note

The sample rules deny direct client writes to orders, stock movements, audit logs, and system documents. Cloud Functions use the Firebase Admin SDK and must enforce authorization and validation themselves. Review rules and function behavior with your Firebase project before production deployment.
