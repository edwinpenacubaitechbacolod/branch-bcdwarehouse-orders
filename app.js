import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, onSnapshot, query, orderBy, limit, where } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

/* Replace with the Firebase Web App configuration from Firebase Console. */
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const createOrder = httpsCallable(functions, "createOrder");
const updateOrderStatus = httpsCallable(functions, "updateOrderStatus");
let currentUser = null, profile = null, allOrders = [], products = [], cart = {};
let unsubOrders = null, unsubProducts = null;

function toast(message, error=false) {
  const el=$("toast"); el.textContent=message; el.classList.remove("hidden");
  el.style.background=error?"#a8293c":"#17253b";
  setTimeout(()=>el.classList.add("hidden"),4000);
}
function escapeHtml(v="") { return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function dateText(v) { try { return v?.toDate ? v.toDate().toLocaleString() : new Date(v).toLocaleString(); } catch { return "—"; } }
function statusPill(s) {
  const cls = s==="Completed"?"green":s==="Cancelled"?"red":s==="Preparing"||s==="Ready for Dispatch"?"orange":"";
  return `<span class="pill ${cls}">${escapeHtml(s||"—")}</span>`;
}
function showPage(page) {
  document.querySelectorAll(".page").forEach(x=>x.classList.add("hidden"));
  $(`${page}Page`).classList.remove("hidden");
  document.querySelectorAll(".nav").forEach(x=>x.classList.toggle("active",x.dataset.page===page));
}
document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>showPage(n.dataset.page)));

$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault(); $("loginMessage").classList.add("hidden");
  try { await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value); }
  catch(err) { $("loginMessage").textContent=err.message; $("loginMessage").classList.remove("hidden"); $("loginMessage").classList.add("error"); }
});
$("logoutBtn").addEventListener("click",()=>signOut(auth));
$("orderSearch").addEventListener("input",renderOrders);
$("statusFilter").addEventListener("change",renderOrders);

onAuthStateChanged(auth,async user=>{
  if(unsubOrders) unsubOrders(); if(unsubProducts) unsubProducts();
  currentUser=user; profile=null;
  if(!user){ $("loginView").classList.remove("hidden"); $("appView").classList.add("hidden"); $("logoutBtn").classList.add("hidden"); $("userLabel").textContent="Not signed in"; return; }
  try {
    const snap=await getDoc(doc(db,"users",user.uid));
    if(!snap.exists() || snap.data().active===false) throw new Error("Your account profile is missing or inactive. Contact the administrator.");
    profile={uid:user.uid,...snap.data()};
    $("loginView").classList.add("hidden"); $("appView").classList.remove("hidden"); $("logoutBtn").classList.remove("hidden");
    $("userLabel").textContent=`${profile.displayName||user.email} · ${profile.role}`;
    const isWarehouse=["warehouse","admin"].includes(profile.role);
    $("inventoryNav").classList.toggle("hidden",!isWarehouse);
    $("newOrderNav").classList.toggle("hidden",profile.role!=="branch");
    $("new-orderPage").classList.toggle("hidden",profile.role!=="branch");
    if(profile.role==="branch") showPage("new-order"); else showPage("dashboard");
    subscribeData();
  } catch(err) { await signOut(auth); $("loginMessage").textContent=err.message; $("loginMessage").classList.remove("hidden"); }
});

function subscribeData(){
  const baseOrders = collection(db,"orders");
  const ordersRef = profile.role === "branch"
    ? query(baseOrders, where("branchId","==",profile.branchId), orderBy("createdAt","desc"), limit(300))
    : query(baseOrders, orderBy("createdAt","desc"), limit(300));
  unsubOrders=onSnapshot(ordersRef,s=>{
    allOrders=s.docs.map(d=>({id:d.id,...d.data()}));
    renderOrders(); renderDashboard();
  },e=>toast("Could not load orders: "+e.message,true));
  unsubProducts=onSnapshot(collection(db,"products"),s=>{
    products=s.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.active!==false).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
    renderProducts(); renderInventory();
  },e=>toast("Could not load products: "+e.message,true));
}
function visibleOrders(){
  return profile.role==="branch" ? allOrders.filter(o=>o.branchId===profile.branchId) : allOrders;
}
function tableHtml(rows,warehouse=false){
  if(!rows.length) return '<div class="empty">No orders found.</div>';
  return `<table><thead><tr><th>Order</th><th>Branch</th><th>Date</th><th>Items</th><th>Status</th>${warehouse?"<th>Action</th>":""}</tr></thead><tbody>${rows.map(o=>{
    const itemCount=(o.items||[]).length;
    const actions=warehouse ? `<td><div class="actions">${warehouseActions(o)}</div></td>`:"";
    return `<tr><td><strong>${escapeHtml(o.orderNo||o.id.slice(0,8))}</strong></td><td>${escapeHtml(o.branchName||"—")}</td><td>${escapeHtml(dateText(o.createdAt))}</td><td>${itemCount}</td><td>${statusPill(o.status)}</td>${actions}</tr>`;
  }).join("")}</tbody></table>`;
}
function warehouseActions(o){
  if(profile.role==="branch") return "";
  if(o.status==="Approved") return `<button class="btn secondary" data-action="Preparing" data-id="${o.id}">Start picking</button>`;
  if(o.status==="Preparing") return `<button class="btn secondary" data-action="Ready for Dispatch" data-id="${o.id}">Ready</button>`;
  if(o.status==="Ready for Dispatch") return `<button class="btn secondary" data-action="Shipped" data-id="${o.id}">Dispatch</button>`;
  if(o.status==="Shipped") return `<button class="btn" data-action="Completed" data-id="${o.id}">Confirm delivery</button>`;
  return "—";
}
function renderOrders(){
  const search=($("orderSearch")?.value||"").toLowerCase(), status=$("statusFilter")?.value||"";
  const rows=visibleOrders().filter(o=>(!status||o.status===status)&&(`${o.orderNo||""} ${o.branchName||""}`.toLowerCase().includes(search)));
  $("ordersTable").innerHTML=tableHtml(rows,profile.role!=="branch");
  $("ordersTable").querySelectorAll("[data-action]").forEach(b=>b.addEventListener("click",async()=>{
    b.disabled=true;
    try { await updateOrderStatus({orderId:b.dataset.id,status:b.dataset.action}); toast(`Order updated: ${b.dataset.action}`); }
    catch(e){toast(e.message,true);b.disabled=false;}
  }));
}
function renderDashboard(){
  const rows=visibleOrders();
  $("statTotal").textContent=rows.length;
  $("statNew").textContent=rows.filter(o=>o.status==="Approved").length;
  $("statPreparing").textContent=rows.filter(o=>["Preparing","Ready for Dispatch"].includes(o.status)).length;
  $("statShipped").textContent=rows.filter(o=>o.status==="Shipped").length;
  $("recentOrders").innerHTML=tableHtml(rows.slice(0,8),profile.role!=="branch");
}
function renderProducts(){
  if(profile.role!=="branch") return;
  $("productList").innerHTML=products.length?products.map(p=>`
    <div class="product"><div><strong>${escapeHtml(p.name)}</strong><small>Unit: ${escapeHtml(p.unit||"piece")} · Available: ${Number(p.stock||0).toLocaleString()}</small></div>
    <div class="qty"><button data-minus="${p.id}">−</button><input aria-label="Quantity" type="number" min="0" max="9999" value="${cart[p.id]||0}" data-qty="${p.id}"><button data-plus="${p.id}">+</button></div></div>`).join(""):'<div class="empty">No active products are available.</div>';
  $("productList").querySelectorAll("[data-minus],[data-plus],[data-qty]").forEach(el=>el.addEventListener("click",()=>{}));
  $("productList").querySelectorAll("[data-minus]").forEach(b=>b.addEventListener("click",()=>setQty(b.dataset.minus,(cart[b.dataset.minus]||0)-1)));
  $("productList").querySelectorAll("[data-plus]").forEach(b=>b.addEventListener("click",()=>setQty(b.dataset.plus,(cart[b.dataset.plus]||0)+1)));
  $("productList").querySelectorAll("[data-qty]").forEach(i=>i.addEventListener("change",()=>setQty(i.dataset.qty,i.value)));
  updateCartSummary();
}
function setQty(id,n){cart[id]=Math.max(0,Math.min(9999,Math.floor(Number(n)||0)));renderProducts();}
function updateCartSummary(){
  const count=Object.values(cart).filter(n=>n>0).length;
  $("cartSummary").textContent=`${count} product${count===1?"":"s"} selected`;
  $("submitOrder").disabled=count===0;
}
$("submitOrder").addEventListener("click",async()=>{
  const items=Object.entries(cart).filter(([,qty])=>qty>0).map(([productId,qty])=>({productId,qty}));
  if(!items.length)return;
  $("submitOrder").disabled=true;
  try {
    const result=await createOrder({items,note:$("orderNote").value.trim()});
    cart={};$("orderNote").value="";renderProducts();
    toast(`Order ${result.data.orderNo} submitted and automatically approved.`);
    showPage("orders");
  } catch(e) { toast(e.message||"Order could not be submitted.",true); $("submitOrder").disabled=false; }
});
function renderInventory(){
  if(!profile || !["warehouse","admin"].includes(profile.role))return;
  $("inventoryTable").innerHTML=products.length?`<table><thead><tr><th>Product</th><th>Unit</th><th>Available stock</th><th>Minimum stock</th><th>Stock status</th></tr></thead><tbody>${products.map(p=>{
    const low=Number(p.stock||0)<=Number(p.minimumStock||0);
    return `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td>${escapeHtml(p.unit||"—")}</td><td>${Number(p.stock||0).toLocaleString()}</td><td>${Number(p.minimumStock||0).toLocaleString()}</td><td>${low?'<span class="pill orange">Low stock</span>':'<span class="pill green">In stock</span>'}</td></tr>`;
  }).join("")}</tbody></table>`:'<div class="empty">No products configured.</div>';
}
