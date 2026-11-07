const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const nodemailer = require("nodemailer");

const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_PORT = defineSecret("SMTP_PORT");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const ORDER_NOTIFICATION_EMAIL = "edwinpenacuba.itechbacolod@gmail.com";

initializeApp();
const db = getFirestore();

async function requireProfile(request, allowedRoles) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const snap = await db.doc(`users/${request.auth.uid}`).get();
  if (!snap.exists || snap.data().active === false) throw new HttpsError("permission-denied", "Account is inactive or not configured.");
  const profile = snap.data();
  if (!allowedRoles.includes(profile.role)) throw new HttpsError("permission-denied", "You do not have permission for this action.");
  return profile;
}
function cleanString(value, max=300) {
  return typeof value === "string" ? value.trim().slice(0,max) : "";
}

exports.createOrder = onCall(async request => {
  const profile = await requireProfile(request, ["branch"]);
  const items = request.data?.items;
  const note = cleanString(request.data?.note, 300);
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new HttpsError("invalid-argument", "Select between 1 and 50 products.");
  const normalized = new Map();
  for (const item of items) {
    const productId = cleanString(item?.productId, 100);
    const qty = Number(item?.qty);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 9999) throw new HttpsError("invalid-argument", "One or more product quantities are invalid.");
    normalized.set(productId, (normalized.get(productId) || 0) + qty);
  }
  const branchSnap = await db.doc(`branches/${profile.branchId}`).get();
  if (!profile.branchId || !branchSnap.exists || branchSnap.data().active === false) throw new HttpsError("failed-precondition", "Your assigned branch is unavailable.");
  const branchName = branchSnap.data().name;
  const orderRef = db.collection("orders").doc();
  const counterRef = db.doc("system/orderCounter");
  const productRefs = [...normalized.keys()].map(id => db.doc(`products/${id}`));
  const movementRefs = [...normalized.keys()].map(() => db.collection("stock_movements").doc());

  const orderNo = await db.runTransaction(async tx => {
    const [counterSnap, ...productSnaps] = await Promise.all([tx.get(counterRef), ...productRefs.map(ref => tx.get(ref))]);
    const productData = [];
    for (let i=0;i<productSnaps.length;i++) {
      const snap=productSnaps[i], productId=[...normalized.keys()][i], qty=normalized.get(productId);
      if (!snap.exists || snap.data().active === false) throw new HttpsError("failed-precondition", `Product ${productId} is unavailable.`);
      const p=snap.data(), stock=Number(p.stock||0);
      if (stock < qty) throw new HttpsError("failed-precondition", `${p.name}: insufficient stock. Available ${stock}, requested ${qty}.`);
      productData.push({ref:productRefs[i],id:productId,qty,product:p,stock});
    }
    const nextNo=Number(counterSnap.exists?counterSnap.data().value:0)+1;
    tx.set(counterRef,{value:nextNo,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    const orderItems=productData.map(x=>({productId:x.id,name:x.product.name,unit:x.product.unit||"piece",qty:x.qty}));
    tx.create(orderRef,{
      orderNo:`BO-${String(nextNo).padStart(6,"0")}`,
      branchId:profile.branchId,branchName,
      createdBy:request.auth.uid,createdByEmail:request.auth.token.email||"",
      items:orderItems,note,status:"Approved",approvalMode:"automatic",
      approvedAt:FieldValue.serverTimestamp(),createdAt:FieldValue.serverTimestamp(),
      stockDeducted:true,deliveryConfirmed:false
    });
    productData.forEach((x,i)=>{
      tx.update(x.ref,{stock:x.stock-x.qty,updatedAt:FieldValue.serverTimestamp()});
      tx.create(movementRefs[i],{
        productId:x.id,productName:x.product.name,type:"order_deduction",
        quantity:-x.qty,stockBefore:x.stock,stockAfter:x.stock-x.qty,
        orderId:orderRef.id,orderNo:`BO-${String(nextNo).padStart(6,"0")}`,
        branchId:profile.branchId,createdBy:request.auth.uid,
        createdAt:FieldValue.serverTimestamp()
      });
    });
    return `BO-${String(nextNo).padStart(6,"0")}`;
  });
  return {orderId:orderRef.id,orderNo};
});

exports.updateOrderStatus = onCall(async request => {
  const profile = await requireProfile(request, ["warehouse","admin"]);
  const orderId=cleanString(request.data?.orderId,120);
  const next=cleanString(request.data?.status,40);
  const allowed=["Preparing","Ready for Dispatch","Shipped","Completed"];
  if (!orderId || !allowed.includes(next)) throw new HttpsError("invalid-argument","Invalid order or status.");
  const ref=db.doc(`orders/${orderId}`);
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists) throw new HttpsError("not-found","Order not found.");
    const order=snap.data();
    const transitions={Approved:"Preparing",Preparing:"Ready for Dispatch","Ready for Dispatch":"Shipped",Shipped:"Completed"};
    if(transitions[order.status]!==next) throw new HttpsError("failed-precondition",`Cannot move order from ${order.status} to ${next}.`);
    const update={status:next,updatedAt:FieldValue.serverTimestamp(),updatedBy:request.auth.uid};
    if(next==="Shipped") update.shippedAt=FieldValue.serverTimestamp();
    if(next==="Completed") {
      update.deliveryConfirmed=true;
      update.deliveryConfirmedAt=FieldValue.serverTimestamp();
      update.deliveryConfirmedBy=request.auth.uid;
      update.deliveryConfirmationMethod="warehouse";
    }
    tx.update(ref,update);
    const logRef=db.collection("audit_logs").doc();
    tx.create(logRef,{entityType:"order",entityId:orderId,action:"status_change",from:order.status,to:next,actorUid:request.auth.uid,actorRole:profile.role,createdAt:FieldValue.serverTimestamp()});
  });
  return {success:true,status:next};
});

/* Admin-only stock receiving/adjustment endpoint. No client-side stock writes. */
exports.adjustInventory = onCall(async request => {
  await requireProfile(request, ["admin"]);
  const productId=cleanString(request.data?.productId,100);
  const quantity=Number(request.data?.quantity);
  const reason=cleanString(request.data?.reason,200);
  if(!productId || !Number.isInteger(quantity) || quantity===0 || Math.abs(quantity)>1000000 || !reason) throw new HttpsError("invalid-argument","Provide a product, non-zero whole-number quantity, and reason.");
  const ref=db.doc(`products/${productId}`), movementRef=db.collection("stock_movements").doc();
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists) throw new HttpsError("not-found","Product not found.");
    const before=Number(snap.data().stock||0), after=before+quantity;
    if(after<0) throw new HttpsError("failed-precondition","Stock cannot become negative.");
    tx.update(ref,{stock:after,updatedAt:FieldValue.serverTimestamp()});
    tx.create(movementRef,{productId,productName:snap.data().name,type:quantity>0?"stock_in":"adjustment",quantity,stockBefore:before,stockAfter:after,reason,createdBy:request.auth.uid,createdAt:FieldValue.serverTimestamp()});
  });
  return {success:true};
});


/*
 * Send the owner an email whenever a branch order is successfully created.
 * SMTP credentials are stored as Firebase Secret Manager secrets, never in
 * browser code or Firestore.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

exports.emailNewBranchOrder = onDocumentCreated(
  {
    document: "orders/{orderId}",
    secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS],
    retry: true
  },
  async event => {
    const order = event.data?.data();
    if (!order) return;

    const port = Number(SMTP_PORT.value() || 587);
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port,
      secure: port === 465,
      auth: {
        user: SMTP_USER.value(),
        pass: SMTP_PASS.value()
      }
    });

    const orderNo = order.orderNo || event.params.orderId;
    const items = Array.isArray(order.items) ? order.items : [];
    const itemRows = items.map(item =>
      `<tr>
        <td style="padding:9px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.name)}</td>
        <td style="padding:9px;border-bottom:1px solid #e5e7eb;text-align:center">${escapeHtml(item.qty)}</td>
        <td style="padding:9px;border-bottom:1px solid #e5e7eb">${escapeHtml(item.unit || "")}</td>
      </tr>`
    ).join("");

    const html = `
      <div style="font-family:Arial,sans-serif;color:#172033;max-width:640px;margin:auto">
        <div style="background:#155eef;color:white;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="margin:0">New Branch Stock Order</h2>
          <p style="margin:8px 0 0">Order ${escapeHtml(orderNo)}</p>
        </div>
        <div style="padding:22px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
          <p><strong>Branch:</strong> ${escapeHtml(order.branchName || "Unknown branch")}</p>
          <p><strong>Status:</strong> ${escapeHtml(order.status || "Submitted")}</p>
          <p><strong>Submitted by:</strong> ${escapeHtml(order.createdByEmail || "Not provided")}</p>
          <h3 style="margin:22px 0 10px">Requested stocks</h3>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:#f3f6fb">
              <th style="padding:9px;text-align:left">Product</th>
              <th style="padding:9px">Quantity</th>
              <th style="padding:9px;text-align:left">Unit</th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
          ${order.note ? `<p style="margin-top:18px"><strong>Branch note:</strong> ${escapeHtml(order.note)}</p>` : ""}
          <p style="color:#667085;font-size:12px;margin-top:24px">
            This is an automatic notification from your Branch Orders website.
          </p>
        </div>
      </div>`;

    await transporter.sendMail({
      from: `"Branch Orders" <${SMTP_USER.value()}>`,
      to: ORDER_NOTIFICATION_EMAIL,
      subject: `New stock order ${orderNo} - ${order.branchName || "Branch"}`,
      text: [
        `New Branch Stock Order: ${orderNo}`,
        `Branch: ${order.branchName || "Unknown branch"}`,
        `Status: ${order.status || "Submitted"}`,
        "",
        ...items.map(item => `${item.name}: ${item.qty} ${item.unit || ""}`),
        order.note ? `\nBranch note: ${order.note}` : ""
      ].join("\n"),
      html
    });
  }
);
