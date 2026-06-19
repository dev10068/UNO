const peer = new Peer();
let connections = [];
const handUI = document.getElementById("hand");
let hand = Array.from({length: 7}, () => ({color: ['red','blue','green','yellow'][Math.floor(Math.random()*4)], number: Math.floor(Math.random()*10)}));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

function render() {
    handUI.innerHTML = "";
    hand.forEach(card => {
        let div = document.createElement("div");
        div.className = `card ${card.color}`;
        div.innerText = card.number;
        div.onclick = () => { hand = hand.filter(c => c !== card); document.getElementById("discard").innerHTML = `<div class="card ${card.color}">${card.number}</div>`; render(); };
        handUI.appendChild(div);
    });
}

document.getElementById("createBtn").onclick = () => {
    peer.on("open", id => { document.getElementById("status").innerText = "Room: " + id; document.getElementById("login-overlay").style.display = "none"; });
};

document.getElementById("joinBtn").onclick = () => {
    let conn = peer.connect(document.getElementById("roomInput").value);
    conn.on("open", () => { document.getElementById("login-overlay").style.display = "none"; });
};
render();
