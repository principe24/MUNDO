"use strict";
const QRCode = require("../external/qr-seat/QRCode");
const correction = require("../external/qr-seat/QRCode/QRErrorCorrectLevel");

// Only called with a seat URL constructed by the game host itself.
function invitationRows(link) {
  const code = new QRCode(-1, correction.M);
  code.addData(link);
  code.make();
  const size = code.getModuleCount();
  return Array.from({length: size}, (_, row) => {
    let line = "";
    for (let col = 0; col < size; col++) line += code.isDark(row, col) ? "1" : "0";
    return line;
  });
}
module.exports = {invitationRows};
