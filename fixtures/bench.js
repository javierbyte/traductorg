// Page-side harness for the OCR benchmark worker. Development only.
const result = document.getElementById("result");
let worker = null;
let nextId = 1;
const pending = new Map();

function request(message, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

async function init(options) {
  worker?.terminate();
  pending.clear();
  worker = new Worker(new URL("./bench-worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "error") entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  worker.addEventListener("error", (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message));
    pending.clear();
  });
  result.textContent = `Loading ${options.engine}: ${options.det}`;
  await request({ type: "init", ...options });
  result.textContent = `Ready: ${options.engine}`;
}

async function run(bitmap) {
  const output = await request({ type: "run", bitmap }, [bitmap]);
  result.textContent = JSON.stringify(output.timings);
  return output;
}

window.bench = { init, run };
