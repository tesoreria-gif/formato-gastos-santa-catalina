import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { extraerGastosDeDocumento } from "./lib/ocr.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("."));

app.post("/api/escanear-documento", async (req, res) => {
  try {
    const data = await extraerGastosDeDocumento(req.body || {});
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error en servidor Express OCR:", error);
    const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
    return res
      .status(status)
      .json({ error: error?.message || "Error al procesar el documento con Claude." });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
