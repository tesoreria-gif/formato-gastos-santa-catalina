import Anthropic from "@anthropic-ai/sdk";

export const CATEGORIAS_VALIDAS = [
  "Combustible",
  "Hospedaje",
  "Alimentación",
  "Otros (Peajes, Transporte, Parqueaderos)",
];

const PROMPT_EXTRACCION = `
Analiza el documento adjunto (recibo individual o planilla de liquidación de viaje) de una empresa de transporte/panificadora en Colombia.
Extrae los datos de cabecera y el desglose de gastos en pesos colombianos (COP).

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques markdown, con esta estructura exacta:
{
  "tipo_documento": "PLANILLA_LIQUIDACION_VIAJE" o "RECIBO_INDIVIDUAL",
  "conductor": string o null,
  "placa": string o null,
  "ruta": string o null,
  "fecha_inicio": string o null,
  "fecha_retorno": string o null,
  "km_inicial": number o null,
  "km_final": number o null,
  "km_total": number o null,
  "gastos": [
    {
      "fecha": string o null,
      "concepto": string,
      "categoria": "Combustible" | "Hospedaje" | "Alimentación" | "Otros (Peajes, Transporte, Parqueaderos)",
      "valor": number,
      "numero_recibo": string o null,
      "observaciones": string o null
    }
  ],
  "total_general": number
}

Reglas:
- Los valores monetarios deben devolverse como números enteros en pesos colombianos (sin puntos, comas ni símbolo $).
- Si un dato no aparece en el documento, usa null (o [] para "gastos" si no hay ninguno).
- "categoria" debe ser exactamente una de las cuatro opciones listadas, elige la más adecuada.
- "total_general" debe ser la suma de todos los valores en "gastos", o el total indicado explícitamente en el documento si existe.
`.trim();

function extraerJson(texto) {
  const limpio = texto
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(limpio);
  } catch {
    const inicio = limpio.indexOf("{");
    const fin = limpio.lastIndexOf("}");
    if (inicio === -1 || fin === -1 || fin < inicio) {
      throw new Error("La respuesta del modelo no contiene un JSON válido.");
    }
    return JSON.parse(limpio.slice(inicio, fin + 1));
  }
}

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });
  }
  return anthropicClient;
}

/**
 * Envía un recibo/planilla (PDF o imagen, en base64) a Claude y devuelve
 * la cabecera de viaje y el desglose de gastos como objeto JSON.
 * Compartido por server.js (Express, local) y api/escanear-documento.js
 * (función serverless de Vercel) para que ambos backends se comporten igual.
 */
export async function extraerGastosDeDocumento({ base64Data, mediaType } = {}) {
  if (!base64Data) {
    const err = new Error("No se recibió el parámetro base64Data.");
    err.status = 400;
    throw err;
  }

  const mType = mediaType || "application/pdf";
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      tipo_documento: "RECIBO_INDIVIDUAL",
      conductor: null,
      placa: null,
      ruta: null,
      fecha_inicio: null,
      fecha_retorno: null,
      km_inicial: null,
      km_final: null,
      km_total: null,
      gastos: [],
      total_general: 0,
      notice: "Servidor activo. Configure ANTHROPIC_API_KEY para habilitar el OCR con Claude.",
    };
  }

  const contentBlock =
    mType === "application/pdf"
      ? {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: base64Data,
          },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: mType,
            data: base64Data,
          },
        };

  const response = await getClient().messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    output_config: { effort: "medium" },
    system:
      "Eres un sistema OCR contable estricto para transporte y liquidaciones de viaje en Colombia. Tu única salida debe ser un JSON válido sin texto adicional ni bloques markdown.",
    messages: [
      {
        role: "user",
        content: [contentBlock, { type: "text", text: PROMPT_EXTRACCION }],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    const err = new Error("El modelo no devolvió texto en la respuesta.");
    err.status = 502;
    throw err;
  }

  const parsedData = extraerJson(textBlock.text);

  if (Array.isArray(parsedData.gastos)) {
    parsedData.gastos = parsedData.gastos
      .filter((g) => g && typeof g === "object" && (g.concepto || g.valor))
      .map((g) => ({
        ...g,
        categoria: CATEGORIAS_VALIDAS.includes(g.categoria)
          ? g.categoria
          : "Otros (Peajes, Transporte, Parqueaderos)",
      }));
  }

  return parsedData;
}
