const scrollLines = document.getElementById("scroll-lines");
for (let index = 1; index <= 45; index++) {
  const card = document.createElement("p");
  card.className = "card";
  card.textContent = `Absatz ${index}: Dieser Text bleibt beim Scrollen stabil und wird nach dem Anhalten aktualisiert.`;
  scrollLines.appendChild(card);
}

const denseGrid = document.getElementById("dense-grid");
for (let index = 1; index <= 160; index++) {
  const cell = document.createElement("p");
  cell.textContent = `Region ${index}: kleiner wiederholbarer Text für die Erkennungsgrenze.`;
  denseGrid.appendChild(cell);
}

const subtitles = [
  "Der erste Untertitel bleibt kurz stehen.",
  "Danach erscheint ein vollständig anderer Satz.",
  "Bewegung im Hintergrund darf keine Warteschlange erzeugen.",
  "Die Übersetzung soll trotzdem regelmäßig aktualisiert werden.",
];
let subtitleIndex = 0;
setInterval(() => {
  subtitleIndex = (subtitleIndex + 1) % subtitles.length;
  document.getElementById("subtitle").textContent = subtitles[subtitleIndex];
}, 2400);

for (const button of document.querySelectorAll("button[data-mode]")) {
  button.addEventListener("click", () => {
    document.querySelector("section.active")?.classList.remove("active");
    document.getElementById(button.dataset.mode).classList.add("active");
    window.scrollTo(0, 0);
  });
}
