// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

// The same little museum page, written once per language the pickers offer.
// The intro shows two of these side by side — the source panel and the target
// panel — so every pair of languages is covered by eight entries instead of
// sixty-four. `words` feeds the pipe toy and must stay short: each word sits in
// a fixed 170px slot, so the two lanes travel in step.
export const EXAMPLES = {
  de: {
    url: "museum.de/nachtwache",
    title: "Die Nachtwache",
    lines: [
      "Gemalt 1642 in Amsterdam.",
      "Öl auf Leinwand, 379 × 453 cm.",
      "Das Bild wurde später beschnitten.",
      "Restauriert im Sommer 2019.",
    ],
    words: ["Hallo Welt!", "Wunderbar!", "Los geht’s!"],
  },
  en: {
    url: "museum.org/night-watch",
    title: "The Night Watch",
    lines: [
      "Painted in 1642 in Amsterdam.",
      "Oil on canvas, 379 × 453 cm.",
      "The picture was later cut down.",
      "Restored in the summer of 2019.",
    ],
    words: ["Hello world!", "Wonderful!", "Let’s go!"],
  },
  es: {
    url: "museo.es/ronda-de-noche",
    title: "La ronda de noche",
    lines: [
      "Pintado en 1642 en Ámsterdam.",
      "Óleo sobre lienzo, 379 × 453 cm.",
      "El cuadro fue recortado más tarde.",
      "Restaurado en el verano de 2019.",
    ],
    words: ["¡Hola mundo!", "¡Maravilloso!", "¡Vamos!"],
  },
  fr: {
    url: "musee.fr/ronde-de-nuit",
    title: "La Ronde de nuit",
    lines: [
      "Peint en 1642 à Amsterdam.",
      "Huile sur toile, 379 × 453 cm.",
      "Le tableau a été rogné plus tard.",
      "Restauré durant l’été 2019.",
    ],
    words: ["Salut, monde !", "Magnifique !", "C’est parti !"],
  },
  it: {
    url: "museo.it/ronda-di-notte",
    title: "La ronda di notte",
    lines: [
      "Dipinto nel 1642 ad Amsterdam.",
      "Olio su tela, 379 × 453 cm.",
      "Il quadro fu poi ritagliato.",
      "Restaurato nell’estate del 2019.",
    ],
    words: ["Ciao mondo!", "Meraviglioso!", "Andiamo!"],
  },
  pt: {
    url: "museu.pt/ronda-da-noite",
    title: "A ronda da noite",
    lines: [
      "Pintado em 1642 em Amesterdão.",
      "Óleo sobre tela, 379 × 453 cm.",
      "O quadro foi cortado mais tarde.",
      "Restaurado no verão de 2019.",
    ],
    words: ["Olá mundo!", "Maravilhoso!", "Vamos lá!"],
  },
  nl: {
    url: "museum.nl/nachtwacht",
    title: "De Nachtwacht",
    lines: [
      "Geschilderd in 1642 in Amsterdam.",
      "Olieverf op doek, 379 × 453 cm.",
      "Het schilderij is later bijgesneden.",
      "Gerestaureerd in de zomer van 2019.",
    ],
    words: ["Hallo wereld!", "Prachtig!", "Daar gaan we!"],
  },
  zh: {
    url: "bowuguan.cn/yexun",
    title: "夜巡",
    lines: [
      "1642 年绘于阿姆斯特丹。",
      "布面油画，379 × 453 厘米。",
      "这幅画后来被裁剪过。",
      "2019 年夏季修复。",
    ],
    words: ["你好，世界！", "太棒了！", "出发！"],
  },
};
