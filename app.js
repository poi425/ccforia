const $ = (s) => document.querySelector(s);

const state = {
  files: [],
  tabs: new Map(), // tabName -> {checked, messages:[]}
};

$("#file").addEventListener("change", (e) => handleFiles(e.target.files));

const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "#777"; });
drop.addEventListener("dragleave", () => { drop.style.borderColor = "#444"; });
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.style.borderColor = "#444";
  handleFiles(e.dataTransfer.files);
});

function handleFiles(fileList){
  const files = [...fileList].filter(f => /\.html?$/i.test(f.name));
  if(!files.length) return;

  Promise.all(files.map(readAsText))
    .then(texts => {
      texts.forEach((html, i) => {
        const f = files[i];
        const parsed = parseCcfoliaLogHTML(html, f.name);
        // parsed: {tabs: Map(tabName -> messages[])}
        for (const [tabName, msgs] of parsed.tabs.entries()){
          if (!state.tabs.has(tabName)){
            state.tabs.set(tabName, { checked:true, messages:[] });
          }
          state.tabs.get(tabName).messages.push(...msgs);
        }
      });

      // 탭별 메시지 시간순 정렬(가능할 때만)
      for (const [tabName, t] of state.tabs.entries()){
        t.messages.sort((a,b) => (a.ts ?? 0) - (b.ts ?? 0));
      }

      renderTabs();
    })
    .catch(console.error);
}

function readAsText(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file, "utf-8");
  });
}

/**
 * 코코포리아 로그 HTML은 버전에 따라 DOM이 바뀔 수 있음.
 * 그래서 “몇 가지 후보 셀렉터”를 돌려서 최대한 뽑는 방식으로 간다.
 */
function parseCcfoliaLogHTML(html, filename){
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 파일명에서 탭명 추정: ルーム名[タブ名].html 형태 :contentReference[oaicite:1]{index=1}
  const tabFromName = guessTabNameFromFilename(filename);

  // 탭이 하나만 있는 로그(“로그 출력”)는 tabFromName에 넣고,
  // “전 로그 출력”은 문서 내 구분을 찾되, 못 찾으면 전부 tabFromName으로.
  const tabs = new Map();

  // 후보1: 로그가 리스트/행 단위로 들어있는 경우
  // (실제 클래스명은 바뀔 수 있으니, 텍스트 구조 기반으로도 fallback)
  const candidates = [
    // 흔한 구조들을 여기에 추가해가면 됨
    "[data-testid='chat-log'] .message",
    ".chat-log .message",
    ".log .message",
    ".message",
    "article .message",
    "li.message",
  ];

  let nodes = [];
  for (const sel of candidates){
    const found = [...doc.querySelectorAll(sel)];
    if (found.length > nodes.length) nodes = found;
  }

  // 후보2: 위가 실패하면, “시간/발언자/본문”으로 보이는 블록을 넓게 잡는다
  if (nodes.length === 0){
    nodes = [...doc.querySelectorAll("li, div, article")].filter(el => {
      const t = (el.textContent || "").trim();
      return /\d{1,2}:\d{2}/.test(t) && t.length < 2000;
    });
  }

  const msgs = [];
  for (const el of nodes){
    const msg = extractMessage(el);
    if (msg) msgs.push(msg);
  }

  const tabName = tabFromName || "메인";
  tabs.set(tabName, msgs);

  return { tabs };
}

function guessTabNameFromFilename(name){
  // "룸명[탭].html" 또는 "Room[Main].html"
  const m = name.match(/\[(.+?)\]\.html?$/i);
  return m ? m[1].trim() : "";
}

function extractMessage(el){
  // 아이콘
  const img = el.querySelector("img");
  const avatar = img?.getAttribute("src") || "";

  const text = (el.textContent || "").replace(/\s+\n/g, "\n").trim();
  if (!text) return null;

  // 시간 추출(최소한 HH:MM)
  const timeMatch = text.match(/(\d{1,2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : "";

  // 날짜가 포함돼 있으면 같이 뽑기(형식 다양해서 느슨하게)
  const dateMatch = text.match(/(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/);
  const date = dateMatch ? dateMatch[1] : "";

  // 발언자/본문 분리: “발언자 본문” 형태를 최대한 유추
  // (코코포리아 로그 HTML의 실제 구조를 확인하면 더 정확하게 고칠 수 있음)
  let name = "";
  let body = text;

  // 줄 기준으로 첫 줄에 시간/이름이 섞인 경우가 많아서 대충 분리
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2){
    // 첫 줄에 이름이 있고, 둘째 줄부터 본문인 케이스
    const head = lines[0];
    const headNoTime = head.replace(/\d{1,2}:\d{2}/, "").trim();
    if (headNoTime && headNoTime.length <= 30){
      name = headNoTime;
      body = lines.slice(1).join("\n");
    }
  }

  // 타임스탬프(정렬용): date+time이 있을 때만
  let ts = null;
  if (date && time){
    // YYYY/MM/DD or YYYY-MM-DD 대응
    const d = date.replace(/\./g,"-").replace(/\//g,"-");
    const iso = `${d}T${time}:00`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) ts = t;
  }

  return { ts, date, time, name, avatar, body };
}

function renderTabs(){
  const box = $("#tabs");
  box.classList.remove("empty");
  box.innerHTML = "";

  const entries = [...state.tabs.entries()];
  if (!entries.length){
    box.classList.add("empty");
    box.textContent = "아직 불러온 파일이 없다.";
    return;
  }

  for (const [tabName, t] of entries){
    const row = document.createElement("label");
    row.className = "tab-item";
    row.innerHTML = `
      <input type="checkbox" ${t.checked ? "checked":""} />
      <div>
        <div>${escapeHtml(tabName)}</div>
        <small>${t.messages.length.toLocaleString()} msgs</small>
      </div>
    `;
    row.querySelector("input").addEventListener("change", (e) => {
      t.checked = e.target.checked;
    });
    box.appendChild(row);
  }
}

$("#build").addEventListener("click", () => {
  const colorMap = safeJson($("#colorMap").value, {});
  const selected = [];
  for (const [tabName, t] of state.tabs.entries()){
    if (!t.checked) continue;
    for (const m of t.messages){
      selected.push({ ...m, tab: tabName });
    }
  }

  // 시간순 정렬(가능하면)
  selected.sort((a,b) => (a.ts ?? 0) - (b.ts ?? 0));

  const html = buildTistoryHtml(selected, colorMap);
  $("#out").value = html;
  $("#copy").disabled = !html.trim();
});

$("#copy").addEventListener("click", async () => {
  const v = $("#out").value;
  if (!v) return;
  await navigator.clipboard.writeText(v);
});

function buildTistoryHtml(messages, colorMap){
  // 요구사항:
  // - Pretendard: 닉네임 semibold / 본문 regular
  // - 본문 9pt 연한 회색, 시간 7pt 회색
  // - 배경 연한 검정
  // - 사람 대화 사이 줄(연한 회색)
  // - 좌우 여백 충분
  // - 행간 좁지 않게

  const css = `
<div style="
  background:#1b1b1b;
  padding:18px 18px;
  border-radius:14px;
">
  <div style="font-family:'Pretendard Variable',Pretendard,system-ui,-apple-system,'Segoe UI',sans-serif;">
`;

  const end = `
  </div>
</div>`.trim();

  const rows = [];
  let prevName = null;

  for (const m of messages){
    const name = (m.name || " ").trim();
    const nickColor = (name && colorMap[name]) ? colorMap[name] : "#cfcfcf"; // 기본도 회색

    // 사람 바뀔 때 구분선
    if (prevName !== null && name !== prevName){
      rows.push(`<div style="height:1px;background:#3a3a3a;margin:10px 0;"></div>`);
    }
    prevName = name;

    const timePart = [m.date, m.time].filter(Boolean).join(" ");
    const header = `
      <div style="display:flex;gap:10px;align-items:flex-start;">
        ${m.avatar ? `<img src="${escapeAttr(m.avatar)}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex:0 0 auto;" />` : `<div style="width:28px;"></div>`}
        <div style="min-width:0;flex:1;">
          <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:9pt;color:${escapeAttr(nickColor)};">${escapeHtml(name || "")}</span>
            ${timePart ? `<span style="font-weight:400;font-size:7pt;color:#9a9a9a;">${escapeHtml(timePart)}</span>` : ``}
          </div>
    `.trim();

    const body = `
          <div style="margin-top:4px;font-weight:400;font-size:9pt;color:#cfcfcf;line-height:1.55;white-space:pre-wrap;word-break:break-word;">
            ${escapeHtml(m.body || "")}
          </div>
        </div>
      </div>
    `.trim();

    rows.push(`<div style="padding:8px 2px;">${header}${body}</div>`);
  }

  return (css + rows.join("\n") + end);
}

function safeJson(str, fallback){
  try { return JSON.parse(str || "{}"); } catch { return fallback; }
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("`","&#096;"); }
