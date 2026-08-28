import { extraerGastosDeDocumento } from "../lib/ocr.js";

/**
 * Función serverless de Vercel equivalente a la ruta Express
 * POST /api/escanear-documento en server.js. Cualquier archivo bajo /api
 * se despliega automáticamente como endpoint (sin configuración extra).
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const data = await extraerGastosDeDocumento(req.body || {});
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error en función serverless OCR:", error);
    const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
    return res
      .status(status)
      .json({ error: error?.message || "Error al procesar el documento con Claude." });
  }
}
