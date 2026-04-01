const CORS_PROXIES = [
  "https://corsproxy.io/?",
  "https://api.allorigins.win/raw?url=",
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://thingproxy.freeboard.io/fetch/",
];

let currentM3U8Url = null;
let allVariants = [];
let hlsInstance = null;

// ── UI helpers ──

function showStatus(message, type) {
  const status = document.getElementById("status");
  status.className = `status ${type}`;
  if (type === "loading") {
    status.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
  } else {
    status.innerHTML = `<span>${message}</span>`;
  }
  status.classList.remove("hidden");
}

function hideStatus() {
  document.getElementById("status").classList.add("hidden");
}

function showResult() {
  document.getElementById("resultSection").classList.remove("hidden");
}

function hideResult() {
  document.getElementById("resultSection").classList.add("hidden");
}

function detectUrlType(url) {
  url = url.trim();
  if (url.match(/\.m3u8(\?|$)/i)) return { type: "m3u8", url };
  if (url.match(/scripts\.converteai\.net\/.+\/player(s)?\/.+\/player\.js/i)) return { type: "player_js", url };
  if (url.match(/scripts\.converteai\.net\/.+\/embed\.html/i)) return { type: "embed", url };
  if (url.match(/^https?:\/\//i)) return { type: "page", url };
  return { type: "unknown", url };
}

// ── Fetch with CORS proxy ──

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function fetchWithProxy(url) {
  const errors = [];

  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: "*/*" } }, 8000);
    if (response.ok) return await response.text();
    errors.push(`Direct: HTTP ${response.status}`);
  } catch (e) {
    errors.push(`Direct: ${e.name === "AbortError" ? "timeout" : e.message}`);
  }

  for (const proxy of CORS_PROXIES) {
    const proxyHost = proxy.split("//")[1].split("/")[0];
    try {
      showStatus(`Tentando proxy: ${proxyHost}...`, "loading");
      const proxyUrl = proxy + encodeURIComponent(url);
      const response = await fetchWithTimeout(proxyUrl, {}, 12000);
      if (response.ok) return await response.text();
      errors.push(`${proxyHost}: HTTP ${response.status}`);
    } catch (e) {
      errors.push(`${proxyHost}: ${e.name === "AbortError" ? "timeout" : e.message}`);
      continue;
    }
  }
  console.error("All proxies failed:", errors);
  throw new Error("Nenhum proxy conseguiu acessar a URL. Erros: " + errors.join(" | "));
}

// ── Extraction helpers ──

function extractM3U8FromText(text) {
  const patterns = [
    /["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/gi,
    /(?:source|src|url|file|video|media|stream|hls|m3u8)["']?\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/gi,
    /data-[\w-]*=["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*?)["']/gi,
  ];
  const found = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[1] || match[0];
      if (url.includes(".m3u8")) {
        const clean = url.replace(/["']/g, "").trim();
        if (clean.startsWith("http")) found.add(clean);
      }
    }
  }
  return [...found];
}

function extractPlayerJsUrls(text) {
  const patterns = [
    /(https?:\/\/scripts\.converteai\.net\/[^"'\s]+\/player\.js)/gi,
    /(https?:\/\/scripts\.converteai\.net\/[^"'\s]+\/embed\.html)/gi,
    /(https?:\/\/scripts\.converteai\.net\/[^"'\s]+\/smartplayer[^"'\s]*\.js)/gi,
  ];
  const found = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}

/**
 * Extract ALL video variants from player.js config.
 * VTurb A/B tests use a tree structure:
 *   config: { fn: "split", children: [ {config: videoA, weight}, {config: videoB, weight} ] }
 * Single video has:
 *   config: { config: { oid, video: { id } } }
 *
 * Returns array of { videoId, oid, cdn, weight, playerId, m3u8 }
 */
function extractAllVariants(jsText) {
  let cdn = "cdn.converteai.net";
  const cdnMatch = jsText.match(/cdn\s*:\s*["']([^"']+converteai[^"']*)["']/i);
  if (cdnMatch) cdn = cdnMatch[1];

  // Extract oid from anywhere in the text
  let globalOid = null;
  const oidMatch = jsText.match(/oid\s*:\s*["']([a-f0-9-]{36})["']/i)
    || jsText.match(/converteai\.net\/([a-f0-9-]{36})/i);
  if (oidMatch) globalOid = oidMatch[1];

  const variants = [];
  const seenVideoIds = new Set();

  // Find ALL video config blocks: video:{...id:"xxx"...}
  // Each one represents a variant
  const videoBlockRegex = /video\s*:\s*\{[^}]*?id\s*:\s*["']([a-f0-9]+)["'][^}]*?\}/gi;
  let match;
  while ((match = videoBlockRegex.exec(jsText)) !== null) {
    const videoId = match[1];
    if (seenVideoIds.has(videoId)) continue;
    seenVideoIds.add(videoId);

    // Try to find the oid near this video config (look backwards for closest oid)
    const textBefore = jsText.substring(Math.max(0, match.index - 2000), match.index);
    const nearOidMatch = textBefore.match(/oid\s*:\s*["']([a-f0-9-]{36})["']/gi);
    const oid = nearOidMatch
      ? nearOidMatch[nearOidMatch.length - 1].match(/["']([a-f0-9-]{36})["']/)[1]
      : globalOid;

    // Try to find player ID near this video config
    const nearPlayerMatch = textBefore.match(/id\s*:\s*["']([a-f0-9]{24})["']/gi);
    const playerId = nearPlayerMatch
      ? nearPlayerMatch[nearPlayerMatch.length - 1].match(/["']([a-f0-9]{24})["']/)[1]
      : null;

    if (oid && videoId) {
      variants.push({
        videoId,
        oid,
        cdn,
        playerId,
        m3u8: `https://${cdn}/${oid}/${videoId}/main.m3u8`,
        weight: null, // will be calculated
      });
    }
  }

  // Try to extract weights/percentages from the config tree
  // VTurb uses children arrays with weight properties for A/B splits
  // Pattern: children:[{...weight:50...},{...weight:50...}]
  const weightRegex = /weight\s*:\s*(\d+(?:\.\d+)?)/gi;
  const weights = [];
  while ((match = weightRegex.exec(jsText)) !== null) {
    weights.push(parseFloat(match[1]));
  }

  // Also check for percentage pattern
  const pctRegex = /percentage\s*:\s*(\d+(?:\.\d+)?)/gi;
  while ((match = pctRegex.exec(jsText)) !== null) {
    weights.push(parseFloat(match[1]));
  }

  // Also check for traffic pattern
  const trafficRegex = /traffic\s*:\s*(\d+(?:\.\d+)?)/gi;
  while ((match = trafficRegex.exec(jsText)) !== null) {
    weights.push(parseFloat(match[1]));
  }

  // Assign weights to variants
  if (weights.length >= variants.length && variants.length > 1) {
    const totalWeight = weights.slice(0, variants.length).reduce((a, b) => a + b, 0);
    for (let i = 0; i < variants.length; i++) {
      variants[i].weight = Math.round((weights[i] / totalWeight) * 100);
    }
  } else if (variants.length > 1) {
    // Equal distribution if no weights found
    const pct = Math.round(100 / variants.length);
    variants.forEach((v, i) => {
      v.weight = i === variants.length - 1 ? 100 - pct * (variants.length - 1) : pct;
    });
  } else if (variants.length === 1) {
    variants[0].weight = 100;
  }

  return variants;
}

/**
 * Simple single-video extraction (fallback)
 */
function extractM3U8FromConfig(jsText) {
  const variants = extractAllVariants(jsText);
  if (variants.length > 0) return variants[0].m3u8;
  return null;
}

function extractVideoConfigFromJS(jsText) {
  const configUrl = extractM3U8FromConfig(jsText);
  if (configUrl) return [configUrl];

  const m3u8Urls = extractM3U8FromText(jsText);
  if (m3u8Urls.length > 0) return m3u8Urls;

  const base64Pattern = /atob\(["']([A-Za-z0-9+/=]+)["']\)/g;
  let match;
  while ((match = base64Pattern.exec(jsText)) !== null) {
    try {
      const decoded = atob(match[1]);
      if (decoded.includes(".m3u8")) m3u8Urls.push(decoded);
      const innerUrls = extractM3U8FromText(decoded);
      m3u8Urls.push(...innerUrls);
    } catch (_) { continue; }
  }
  if (m3u8Urls.length > 0) return m3u8Urls;

  const concatPattern = /["'](https?:\/\/[^"']+)["']\s*\+\s*["']([^"']+\.m3u8[^"']*)["']/gi;
  while ((match = concatPattern.exec(jsText)) !== null) {
    m3u8Urls.push(match[1] + match[2]);
  }
  return m3u8Urls;
}

// ── Main analysis ──

async function analyzeVideo() {
  const input = document.getElementById("videoUrl").value.trim();
  if (!input) {
    showStatus("Por favor, cole uma URL.", "error");
    return;
  }

  const btn = document.getElementById("btnAnalyze");
  btn.disabled = true;
  hideResult();
  hideStatus();
  allVariants = [];

  const detected = detectUrlType(input);

  try {
    switch (detected.type) {
      case "m3u8":
        showStatus("URL M3U8 detectada. Carregando player...", "loading");
        allVariants = [{ videoId: null, m3u8: detected.url, weight: 100 }];
        break;

      case "player_js":
        showStatus("Script do player detectado. Extraindo videos...", "loading");
        allVariants = await extractVariantsFromPlayerJS(detected.url);
        break;

      case "embed":
        showStatus("Embed VTurb detectado. Extraindo videos...", "loading");
        allVariants = await extractVariantsFromEmbed(detected.url);
        break;

      case "page":
        showStatus("Analisando pagina para encontrar videos VTurb...", "loading");
        allVariants = await extractVariantsFromPage(detected.url);
        break;

      default:
        showStatus("Formato de URL nao reconhecido. Cole a URL completa da pagina.", "error");
        btn.disabled = false;
        return;
    }

    if (allVariants.length > 0) {
      currentM3U8Url = allVariants[0].m3u8;

      if (allVariants.length > 1) {
        showStatus(`Teste A/B detectado! ${allVariants.length} variantes encontradas.`, "success");
      } else {
        showStatus("Video encontrado!", "success");
      }

      renderVariants(allVariants);
      showResult();
    } else {
      showStatus(
        "Nao foi possivel encontrar o video automaticamente. Tente o metodo manual via DevTools (veja instrucoes abaixo).",
        "error"
      );
    }
  } catch (error) {
    console.error("Erro na analise:", error);
    showStatus(`Erro: ${error.message}`, "error");
  }

  btn.disabled = false;
}

async function extractVariantsFromPlayerJS(url) {
  const jsContent = await fetchWithProxy(url);
  const variants = extractAllVariants(jsContent);
  if (variants.length > 0) return variants;
  // Fallback to simple extraction
  const urls = extractVideoConfigFromJS(jsContent);
  return urls.map(u => ({ videoId: null, m3u8: u, weight: 100 }));
}

async function extractVariantsFromEmbed(url) {
  const html = await fetchWithProxy(url);

  const playerJsUrls = extractPlayerJsUrls(html);
  for (const jsUrl of playerJsUrls) {
    try {
      const jsContent = await fetchWithProxy(jsUrl);
      const variants = extractAllVariants(jsContent);
      if (variants.length > 0) return variants;
    } catch (_) { continue; }
  }

  const m3u8Urls = extractM3U8FromText(html);
  return m3u8Urls.map(u => ({ videoId: null, m3u8: u, weight: 100 }));
}

async function extractVariantsFromPage(url) {
  const html = await fetchWithProxy(url);

  // 1. Try config extraction directly from inline scripts
  let variants = extractAllVariants(html);
  if (variants.length > 0) return variants;

  // 2. Find and fetch all player.js scripts (there may be multiple for A/B)
  const playerJsUrls = extractPlayerJsUrls(html);
  const allPlayerVariants = [];

  for (const jsUrl of playerJsUrls) {
    try {
      showStatus("Analisando script do player...", "loading");
      if (jsUrl.includes("embed.html")) {
        const embedVariants = await extractVariantsFromEmbed(jsUrl);
        allPlayerVariants.push(...embedVariants);
        continue;
      }
      // Extract player ID from the URL path: /players/{playerId}/
      const urlPlayerIdMatch = jsUrl.match(/\/players\/([a-f0-9]+)\//i);
      const urlPlayerId = urlPlayerIdMatch ? urlPlayerIdMatch[1] : null;

      const jsContent = await fetchWithProxy(jsUrl);
      const jsVariants = extractAllVariants(jsContent);
      if (jsVariants.length > 0) {
        // Tag each variant with the player ID from the URL
        jsVariants.forEach(v => { if (urlPlayerId) v.playerId = urlPlayerId; });
        allPlayerVariants.push(...jsVariants);
      }
    } catch (_) { continue; }
  }

  if (allPlayerVariants.length > 0) {
    // Deduplicate by videoId
    const seen = new Set();
    const deduped = allPlayerVariants.filter(v => {
      if (seen.has(v.videoId || v.m3u8)) return false;
      seen.add(v.videoId || v.m3u8);
      return true;
    });
    // Recalculate weights if we merged from multiple sources
    if (deduped.length > 1 && deduped.every(v => v.weight === 100)) {
      const pct = Math.round(100 / deduped.length);
      deduped.forEach((v, i) => {
        v.weight = i === deduped.length - 1 ? 100 - pct * (deduped.length - 1) : pct;
      });
    }
    return deduped;
  }

  // 3. Look for VTurb iframes
  const iframePattern = /src=["'](https?:\/\/[^"']*(?:converteai|vturb|smartplayer)[^"']*)["']/gi;
  let match;
  while ((match = iframePattern.exec(html)) !== null) {
    try {
      const iframeSrc = match[1];
      showStatus("Analisando iframe do VTurb...", "loading");
      const iframeHtml = await fetchWithProxy(iframeSrc);

      variants = extractAllVariants(iframeHtml);
      if (variants.length > 0) return variants;

      const innerPlayerUrls = extractPlayerJsUrls(iframeHtml);
      for (const innerJsUrl of innerPlayerUrls) {
        try {
          const innerJs = await fetchWithProxy(innerJsUrl);
          variants = extractAllVariants(innerJs);
          if (variants.length > 0) return variants;
        } catch (_) { continue; }
      }
    } catch (_) { continue; }
  }

  // 4. Reconstruct player.js URL from smartplayer tag + workspace ID
  const smartplayerPattern = /id=["'](vid-[a-f0-9]+)["']/gi;
  const workspacePattern = /scripts\.converteai\.net\/([a-f0-9-]+)/gi;

  let playerId = null;
  let workspaceId = null;

  while ((match = smartplayerPattern.exec(html)) !== null) {
    playerId = match[1].replace("vid-", "");
  }
  while ((match = workspacePattern.exec(html)) !== null) {
    workspaceId = match[1];
  }

  if (playerId && workspaceId) {
    const playerJsUrl = `https://scripts.converteai.net/${workspaceId}/players/${playerId}/v4/player.js`;
    try {
      showStatus("Tentando reconstruir URL do player...", "loading");
      const jsContent = await fetchWithProxy(playerJsUrl);
      variants = extractAllVariants(jsContent);
      if (variants.length > 0) return variants;
    } catch (_) {}
  }

  return [];
}

// ── Render variants ──

function renderVariants(variants) {
  const container = document.getElementById("variantsContainer");
  container.innerHTML = "";

  if (variants.length <= 1) {
    // Single video - simple view
    container.classList.add("hidden");
    document.getElementById("singleVideoSection").classList.remove("hidden");
    initPlayer(variants[0].m3u8);
    document.getElementById("m3u8Url").textContent = variants[0].m3u8;
    return;
  }

  // Multiple variants (A/B test)
  container.classList.remove("hidden");
  document.getElementById("singleVideoSection").classList.add("hidden");

  variants.forEach((variant, index) => {
    const letter = String.fromCharCode(65 + index); // A, B, C...
    const card = document.createElement("div");
    card.className = "variant-card";
    card.id = `variantCard_${index}`;

    card.innerHTML = `
      <div class="variant-header">
        <div class="variant-label">
          <span class="variant-letter">${letter}</span>
          <span class="variant-title">Variante ${letter}</span>
        </div>
        <span class="variant-weight-info">% definido no painel VTurb</span>
      </div>
      <div class="variant-video-wrapper">
        <video class="variant-video" id="variantVideo_${index}" controls playsinline></video>
      </div>
      <div class="variant-actions">
        <button class="btn-primary btn-sm" onclick="downloadVariant(${index})">Baixar Video</button>
        <button class="btn-secondary btn-sm" onclick="copyVariantM3U8(${index})">Copiar M3U8</button>
        <button class="btn-secondary btn-sm" onclick="copyVariantFfmpeg(${index})">Copiar ffmpeg</button>
      </div>
      <div class="variant-m3u8-url">${variant.m3u8}</div>
    `;
    container.appendChild(card);

    // Only init player on first render (avoid reloading videos on re-render)
    const video = document.getElementById(`variantVideo_${index}`);
    if (video && !video.src && !video._hlsAttached) {
      video._hlsAttached = true;
      initVariantPlayer(variant.m3u8, `variantVideo_${index}`);
    }
  });
}

function initVariantPlayer(m3u8Url, videoElementId) {
  const video = document.getElementById(videoElementId);
  if (!video) return;

  if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
    hls.loadSource(m3u8Url);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        hls.destroy();
        // Try with proxy
        for (const proxy of CORS_PROXIES) {
          try {
            const hls2 = new Hls({
              enableWorker: true,
              xhrSetup: (xhr, url) => {
                if (!url.startsWith(proxy)) xhr.open("GET", proxy + encodeURIComponent(url), true);
              },
            });
            hls2.loadSource(proxy + encodeURIComponent(m3u8Url));
            hls2.attachMedia(video);
            break;
          } catch (_) { continue; }
        }
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = m3u8Url;
  }
}

function downloadVariant(index) {
  currentM3U8Url = allVariants[index].m3u8;
  const video = document.getElementById(`variantVideo_${index}`);
  downloadVideoFromElement(video);
}

function copyVariantM3U8(index) {
  const url = allVariants[index].m3u8;
  navigator.clipboard.writeText(url).then(() => {
    showStatus(`URL M3U8 da variante ${String.fromCharCode(65 + index)} copiada!`, "success");
    setTimeout(hideStatus, 2000);
  }).catch(() => prompt("Copie a URL:", url));
}

function copyVariantFfmpeg(index) {
  const url = allVariants[index].m3u8;
  const letter = String.fromCharCode(65 + index).toLowerCase();
  const cmd = `ffmpeg -i "${url}" -c copy -bsf:a aac_adtstoasc video_variante_${letter}.mp4`;
  navigator.clipboard.writeText(cmd).then(() => {
    showStatus(`Comando ffmpeg da variante ${String.fromCharCode(65 + index)} copiado!`, "success");
    setTimeout(hideStatus, 2000);
  }).catch(() => prompt("Copie o comando:", cmd));
}

// ── Single video player ──

function initPlayer(m3u8Url) {
  const video = document.getElementById("videoPlayer");

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true, maxBufferLength: 60 });
    hlsInstance.loadSource(m3u8Url);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.error("HLS error:", data);
        tryPlayerWithProxy(m3u8Url, video);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = m3u8Url;
    video.addEventListener("loadedmetadata", () => { video.play().catch(() => {}); });
  }
}

function tryPlayerWithProxy(m3u8Url, video) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  for (const proxy of CORS_PROXIES) {
    try {
      const proxiedUrl = proxy + encodeURIComponent(m3u8Url);
      hlsInstance = new Hls({
        enableWorker: true,
        xhrSetup: (xhr, url) => {
          if (!url.startsWith(proxy)) xhr.open("GET", proxy + encodeURIComponent(url), true);
        },
      });
      hlsInstance.loadSource(proxiedUrl);
      hlsInstance.attachMedia(video);
      break;
    } catch (_) { continue; }
  }
}

// ── Download ──

function downloadVideo() {
  if (!currentM3U8Url) { showStatus("Nenhum video para baixar.", "error"); return; }
  downloadVideoFromElement(document.getElementById("videoPlayer"));
}

function downloadVideoFromElement(video) {
  const progressSection = document.getElementById("downloadProgress");
  progressSection.classList.remove("hidden");
  // Scroll to progress
  progressSection.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const progressText = document.getElementById("progressText");
  const progressFill = document.getElementById("progressFill");
  progressText.textContent = "Preparando download...";
  progressFill.style.width = "10%";

  if (typeof MediaRecorder !== "undefined" && video.captureStream) {
    try {
      progressText.textContent = "Gravando video... Aguarde o video terminar ou clique para parar.";
      progressFill.style.width = "20%";

      const stream = video.captureStream();
      const mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
      const chunks = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      mediaRecorder.onstop = () => {
        progressFill.style.width = "90%";
        progressText.textContent = "Gerando arquivo...";

        const blob = new Blob(chunks, { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `vturb-video-${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        progressFill.style.width = "100%";
        progressText.textContent = "Download concluido!";
        setTimeout(() => progressSection.classList.add("hidden"), 3000);
      };

      video.currentTime = 0;
      video.play();
      mediaRecorder.start(1000);

      const updateProgress = () => {
        if (video.duration && mediaRecorder.state === "recording") {
          const percent = 20 + (video.currentTime / video.duration) * 70;
          progressFill.style.width = `${Math.min(percent, 90)}%`;
          progressText.textContent = `Gravando: ${Math.round((video.currentTime / video.duration) * 100)}%`;
        }
        if (mediaRecorder.state === "recording") requestAnimationFrame(updateProgress);
      };
      updateProgress();

      video.onended = () => { if (mediaRecorder.state === "recording") mediaRecorder.stop(); };

      const existingBtn = progressSection.querySelector(".stop-btn");
      if (existingBtn) existingBtn.remove();

      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Parar e Salvar";
      stopBtn.className = "btn-primary stop-btn";
      stopBtn.style.marginTop = "0.8rem";
      stopBtn.onclick = () => {
        if (mediaRecorder.state === "recording") { video.pause(); mediaRecorder.stop(); }
        stopBtn.remove();
      };
      progressSection.appendChild(stopBtn);
    } catch (err) {
      console.error("MediaRecorder error:", err);
      fallbackDownload();
    }
  } else {
    fallbackDownload();
  }
}

function getSupportedMimeType() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const type of types) { if (MediaRecorder.isTypeSupported(type)) return type; }
  return "video/webm";
}

function fallbackDownload() {
  const progressSection = document.getElementById("downloadProgress");
  const progressText = document.getElementById("progressText");
  const progressFill = document.getElementById("progressFill");
  progressFill.style.width = "100%";
  progressText.innerHTML = `
    Seu navegador nao suporta gravacao direta.<br><br>
    <strong>Use o ffmpeg no terminal:</strong><br>
    <code style="display:block;background:#0a0a0f;padding:8px;border-radius:4px;margin-top:4px;font-size:0.8rem;word-break:break-all;">
    ffmpeg -i "${currentM3U8Url}" -c copy -bsf:a aac_adtstoasc video.mp4
    </code>`;
}

// ── Clipboard helpers (single video) ──

function copyM3U8() {
  if (!currentM3U8Url) return;
  const m3u8Info = document.getElementById("m3u8Info");
  m3u8Info.classList.toggle("hidden");
  if (!m3u8Info.classList.contains("hidden")) {
    navigator.clipboard.writeText(currentM3U8Url).then(() => {
      showStatus("URL M3U8 copiada!", "success");
      setTimeout(hideStatus, 2000);
    }).catch(() => {
      const code = document.getElementById("m3u8Url");
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }
}

function copyFfmpeg() {
  if (!currentM3U8Url) return;
  const cmd = `ffmpeg -i "${currentM3U8Url}" -c copy -bsf:a aac_adtstoasc video.mp4`;
  navigator.clipboard.writeText(cmd).then(() => {
    showStatus("Comando ffmpeg copiado!", "success");
    setTimeout(hideStatus, 2000);
  }).catch(() => prompt("Copie o comando:", cmd));
}

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("videoUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyzeVideo();
  });
});
