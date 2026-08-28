"use strict";

const CATEGORIAS = [
  "Combustible",
  "Hospedaje",
  "Alimentación",
  "Otros (Peajes, Transporte, Parqueaderos)",
];

const STORAGE_KEY = "santaCatalinaGastosViaje_v1";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const state = {
  header: {
    conductor: "",
    placa: "",
    ruta: "",
    fechaInicio: "",
    fechaRetorno: "",
    kmInicial: "",
    kmFinal: "",
  },
  gastos: [], // { id, fecha, concepto, categoria, numeroRecibo, valor, observaciones }
};

let ultimoResultadoOcr = null;

// ---------- Utilidades ----------

function uid() {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Interpreta montos en formato colombiano ("10.000" -> 10000, "10.000,50" -> 10000.5)
 * y también formatos con separador decimal en punto ("10,000.00" -> 10000).
 */
function parseCopAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return 0;

  let str = String(value).trim().replace(/[^0-9.,-]/g, "");
  if (!str) return 0;

  const lastComma = str.lastIndexOf(",");
  const lastDot = str.lastIndexOf(".");
  let decimalSep = null;

  if (lastComma !== -1 && lastDot !== -1) {
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma !== -1) {
    const parts = str.split(",");
    decimalSep = parts.length === 2 && parts[1].length <= 2 ? "," : null;
  } else if (lastDot !== -1) {
    const parts = str.split(".");
    decimalSep = parts.length === 2 && parts[1].length <= 2 ? "." : null;
  }

  let integerPart = str;
  let decimalPart = "";
  if (decimalSep) {
    const idx = str.lastIndexOf(decimalSep);
    integerPart = str.slice(0, idx);
    decimalPart = str.slice(idx + 1);
  }
  integerPart = integerPart.replace(/[.,]/g, "");

  const normalized = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : 0;
}

function formatCOP(num) {
  const value = Number.isFinite(num) ? num : 0;
  try {
    return value.toLocaleString("es-CO", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0,
    });
  } catch {
    return `$${Math.round(value).toLocaleString("es-CO")}`;
  }
}

function categoriaValida(cat) {
  return CATEGORIAS.includes(cat) ? cat : CATEGORIAS[CATEGORIAS.length - 1];
}

// ---------- Referencias DOM ----------

const el = {
  conductor: document.getElementById("conductor"),
  placa: document.getElementById("placa"),
  ruta: document.getElementById("ruta"),
  fechaInicio: document.getElementById("fechaInicio"),
  fechaRetorno: document.getElementById("fechaRetorno"),
  kmInicial: document.getElementById("kmInicial"),
  kmFinal: document.getElementById("kmFinal"),
  kmTotal: document.getElementById("kmTotal"),
  tablaGastos: document.getElementById("tablaGastos"),
  totalGeneral: document.getElementById("totalGeneral"),
  btnAgregarFila: document.getElementById("btnAgregarFila"),
  btnImprimir: document.getElementById("btnImprimir"),

  btnEscanear: document.getElementById("btnEscanear"),
  modalOverlay: document.getElementById("modalOverlay"),
  btnCerrarModal: document.getElementById("btnCerrarModal"),
  ocrStepUpload: document.getElementById("ocrStepUpload"),
  ocrStepLoading: document.getElementById("ocrStepLoading"),
  ocrStepReview: document.getElementById("ocrStepReview"),
  inputArchivo: document.getElementById("inputArchivo"),
  ocrError: document.getElementById("ocrError"),
  ocrNotice: document.getElementById("ocrNotice"),
  btnProcesar: document.getElementById("btnProcesar"),
  btnVolverSubir: document.getElementById("btnVolverSubir"),
  btnInsertar: document.getElementById("btnInsertar"),
  tablaRevisionOcr: document.getElementById("tablaRevisionOcr"),
};

// ---------- Renderizado de la planilla ----------

function crearSelectCategoria(valorActual) {
  const select = document.createElement("select");
  select.dataset.field = "categoria";
  for (const cat of CATEGORIAS) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    if (cat === valorActual) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function crearInput(field, type, value) {
  const input = document.createElement("input");
  input.type = type;
  input.dataset.field = field;
  input.value = value ?? "";
  return input;
}

function renderFila(gasto) {
  const tr = document.createElement("tr");
  tr.dataset.id = gasto.id;

  const tdFecha = document.createElement("td");
  tdFecha.appendChild(crearInput("fecha", "date", gasto.fecha));

  const tdConcepto = document.createElement("td");
  tdConcepto.appendChild(crearInput("concepto", "text", gasto.concepto));

  const tdCategoria = document.createElement("td");
  tdCategoria.appendChild(crearSelectCategoria(gasto.categoria));

  const tdRecibo = document.createElement("td");
  tdRecibo.appendChild(crearInput("numeroRecibo", "text", gasto.numeroRecibo));

  const tdValor = document.createElement("td");
  const inputValor = crearInput("valor", "text", gasto.valor ? String(gasto.valor) : "");
  inputValor.classList.add("input-valor");
  inputValor.inputMode = "decimal";
  tdValor.appendChild(inputValor);

  const tdObs = document.createElement("td");
  tdObs.appendChild(crearInput("observaciones", "text", gasto.observaciones));

  const tdAcciones = document.createElement("td");
  tdAcciones.classList.add("col-acciones");
  const btnEliminar = document.createElement("button");
  btnEliminar.type = "button";
  btnEliminar.className = "btn-eliminar-fila";
  btnEliminar.textContent = "✕";
  btnEliminar.title = "Eliminar fila";
  tdAcciones.appendChild(btnEliminar);

  tr.append(tdFecha, tdConcepto, tdCategoria, tdRecibo, tdValor, tdObs, tdAcciones);
  return tr;
}

function renderTabla() {
  el.tablaGastos.innerHTML = "";
  for (const gasto of state.gastos) {
    el.tablaGastos.appendChild(renderFila(gasto));
  }
}

function agregarFila(gastoParcial = {}) {
  const gasto = {
    id: uid(),
    fecha: gastoParcial.fecha || "",
    concepto: gastoParcial.concepto || "",
    categoria: categoriaValida(gastoParcial.categoria),
    numeroRecibo: gastoParcial.numeroRecibo || "",
    valor: parseCopAmount(gastoParcial.valor),
    observaciones: gastoParcial.observaciones || "",
  };
  state.gastos.push(gasto);
  el.tablaGastos.appendChild(renderFila(gasto));
  calculateTripForm();
  return gasto;
}

function eliminarFila(id) {
  state.gastos = state.gastos.filter((g) => g.id !== id);
  const tr = el.tablaGastos.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.remove();
  calculateTripForm();
}

function actualizarGasto(id, field, rawValue) {
  const gasto = state.gastos.find((g) => g.id === id);
  if (!gasto) return;
  if (field === "valor") {
    gasto.valor = parseCopAmount(rawValue);
  } else {
    gasto[field] = rawValue;
  }
}

// ---------- Cálculos de la planilla ----------

function calculateTripForm() {
  const kmInicial = parseFloat(el.kmInicial.value);
  const kmFinal = parseFloat(el.kmFinal.value);
  if (Number.isFinite(kmInicial) && Number.isFinite(kmFinal) && kmFinal >= kmInicial) {
    el.kmTotal.value = `${kmFinal - kmInicial} km`;
  } else {
    el.kmTotal.value = "";
  }

  const total = state.gastos.reduce((sum, g) => sum + (Number(g.valor) || 0), 0);
  el.totalGeneral.textContent = formatCOP(total);

  guardarEstado();
}

// ---------- Insertar resultados de OCR en la planilla (1 clic) ----------

function insertarGastosEnPlanilla(dataOCR) {
  if (!dataOCR || typeof dataOCR !== "object") return;

  const asignarSiVacio = (campoEl, valor) => {
    if (valor !== null && valor !== undefined && valor !== "" && !campoEl.value) {
      campoEl.value = valor;
    }
  };

  asignarSiVacio(el.conductor, dataOCR.conductor);
  asignarSiVacio(el.placa, dataOCR.placa);
  asignarSiVacio(el.ruta, dataOCR.ruta);
  if (dataOCR.fecha_inicio && !el.fechaInicio.value) {
    el.fechaInicio.value = normalizarFecha(dataOCR.fecha_inicio);
  }
  if (dataOCR.fecha_retorno && !el.fechaRetorno.value) {
    el.fechaRetorno.value = normalizarFecha(dataOCR.fecha_retorno);
  }
  if (Number.isFinite(dataOCR.km_inicial) && !el.kmInicial.value) {
    el.kmInicial.value = dataOCR.km_inicial;
  }
  if (Number.isFinite(dataOCR.km_final) && !el.kmFinal.value) {
    el.kmFinal.value = dataOCR.km_final;
  }

  const gastos = Array.isArray(dataOCR.gastos) ? dataOCR.gastos : [];
  for (const g of gastos) {
    agregarFila({
      fecha: normalizarFecha(g.fecha) || el.fechaInicio.value || "",
      concepto: g.concepto || "",
      categoria: g.categoria,
      numeroRecibo: g.numero_recibo || g.numeroRecibo || "",
      valor: g.valor,
      observaciones: g.observaciones || "",
    });
  }

  calculateTripForm();
}

function normalizarFecha(valor) {
  if (!valor) return "";
  const match = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[0];
  const dmy = String(valor).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return "";
}

// ---------- Persistencia local ----------

function guardarEstado() {
  state.header = {
    conductor: el.conductor.value,
    placa: el.placa.value,
    ruta: el.ruta.value,
    fechaInicio: el.fechaInicio.value,
    fechaRetorno: el.fechaRetorno.value,
    kmInicial: el.kmInicial.value,
    kmFinal: el.kmFinal.value,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* almacenamiento no disponible: continuar sin persistencia */
  }
}

function cargarEstado() {
  let guardado = null;
  try {
    guardado = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    guardado = null;
  }

  if (guardado && typeof guardado === "object") {
    Object.assign(state.header, guardado.header || {});
    state.gastos = Array.isArray(guardado.gastos) ? guardado.gastos : [];
  }

  el.conductor.value = state.header.conductor || "";
  el.placa.value = state.header.placa || "";
  el.ruta.value = state.header.ruta || "";
  el.fechaInicio.value = state.header.fechaInicio || "";
  el.fechaRetorno.value = state.header.fechaRetorno || "";
  el.kmInicial.value = state.header.kmInicial || "";
  el.kmFinal.value = state.header.kmFinal || "";

  renderTabla();
  if (state.gastos.length === 0) agregarFila();
  calculateTripForm();
}

// ---------- Modal OCR ----------

function abrirModal() {
  el.modalOverlay.hidden = false;
  mostrarPasoOcr("upload");
  el.inputArchivo.value = "";
  el.btnProcesar.disabled = true;
  ocultarError();
}

function cerrarModal() {
  el.modalOverlay.hidden = true;
  ultimoResultadoOcr = null;
}

function mostrarPasoOcr(paso) {
  el.ocrStepUpload.hidden = paso !== "upload";
  el.ocrStepLoading.hidden = paso !== "loading";
  el.ocrStepReview.hidden = paso !== "review";
}

function mostrarError(mensaje) {
  el.ocrError.textContent = mensaje;
  el.ocrError.hidden = false;
}

function ocultarError() {
  el.ocrError.hidden = true;
  el.ocrError.textContent = "";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function renderTablaRevision(gastos) {
  el.tablaRevisionOcr.innerHTML = "";
  if (!gastos.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "review-empty";
    td.textContent = "No se detectaron gastos en el documento.";
    tr.appendChild(td);
    el.tablaRevisionOcr.appendChild(tr);
    return;
  }

  gastos.forEach((g, index) => {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    tdCheck.appendChild(checkbox);

    const tdFecha = document.createElement("td");
    tdFecha.textContent = g.fecha || "-";

    const tdConcepto = document.createElement("td");
    tdConcepto.textContent = g.concepto || "-";

    const tdCategoria = document.createElement("td");
    tdCategoria.textContent = g.categoria || "-";

    const tdRecibo = document.createElement("td");
    tdRecibo.textContent = g.numero_recibo || g.numeroRecibo || "-";

    const tdValor = document.createElement("td");
    tdValor.textContent = formatCOP(parseCopAmount(g.valor));

    tr.append(tdCheck, tdFecha, tdConcepto, tdCategoria, tdRecibo, tdValor);
    el.tablaRevisionOcr.appendChild(tr);
  });
}

async function procesarDocumento() {
  const file = el.inputArchivo.files && el.inputArchivo.files[0];
  if (!file) {
    mostrarError("Selecciona un archivo primero.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    mostrarError("El archivo supera el tamaño máximo permitido (20MB).");
    return;
  }

  ocultarError();
  mostrarPasoOcr("loading");

  try {
    const base64Data = await fileToBase64(file);
    const mediaType = file.type || "application/pdf";

    const respuesta = await fetch("/api/escanear-documento", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64Data, mediaType }),
    });

    const data = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      throw new Error(data.error || "Error al procesar el documento.");
    }

    ultimoResultadoOcr = data;

    el.ocrNotice.hidden = !data.notice;
    el.ocrNotice.textContent = data.notice || "";

    renderTablaRevision(Array.isArray(data.gastos) ? data.gastos : []);
    mostrarPasoOcr("review");
  } catch (error) {
    mostrarPasoOcr("upload");
    mostrarError(error.message || "Error inesperado al procesar el documento.");
  }
}

function confirmarInsercion() {
  if (!ultimoResultadoOcr) {
    cerrarModal();
    return;
  }

  const checkboxes = el.tablaRevisionOcr.querySelectorAll('input[type="checkbox"]');
  const gastosOriginales = Array.isArray(ultimoResultadoOcr.gastos) ? ultimoResultadoOcr.gastos : [];
  const gastosSeleccionados = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) {
      const idx = Number(cb.dataset.index);
      if (gastosOriginales[idx]) gastosSeleccionados.push(gastosOriginales[idx]);
    }
  });

  insertarGastosEnPlanilla({ ...ultimoResultadoOcr, gastos: gastosSeleccionados });
  cerrarModal();
}

// ---------- Eventos ----------

el.tablaGastos.addEventListener("input", (event) => {
  const tr = event.target.closest("tr");
  if (!tr) return;
  const field = event.target.dataset.field;
  if (!field) return;
  actualizarGasto(tr.dataset.id, field, event.target.value);
  if (field === "valor") calculateTripForm();
  else guardarEstado();
});

el.tablaGastos.addEventListener("change", (event) => {
  const tr = event.target.closest("tr");
  if (!tr) return;
  const field = event.target.dataset.field;
  if (field === "categoria") {
    actualizarGasto(tr.dataset.id, field, event.target.value);
    guardarEstado();
  }
});

el.tablaGastos.addEventListener("click", (event) => {
  if (event.target.classList.contains("btn-eliminar-fila")) {
    const tr = event.target.closest("tr");
    if (tr) eliminarFila(tr.dataset.id);
  }
});

[el.kmInicial, el.kmFinal].forEach((input) => {
  input.addEventListener("input", calculateTripForm);
});

[el.conductor, el.placa, el.ruta, el.fechaInicio, el.fechaRetorno].forEach((input) => {
  input.addEventListener("input", guardarEstado);
});

el.btnAgregarFila.addEventListener("click", () => agregarFila());

el.btnImprimir.addEventListener("click", () => window.print());

el.btnEscanear.addEventListener("click", abrirModal);
el.btnCerrarModal.addEventListener("click", cerrarModal);
el.modalOverlay.addEventListener("click", (event) => {
  if (event.target === el.modalOverlay) cerrarModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.modalOverlay.hidden) cerrarModal();
});

el.inputArchivo.addEventListener("change", () => {
  el.btnProcesar.disabled = !(el.inputArchivo.files && el.inputArchivo.files[0]);
  ocultarError();
});

el.btnProcesar.addEventListener("click", procesarDocumento);
el.btnVolverSubir.addEventListener("click", () => {
  mostrarPasoOcr("upload");
  el.inputArchivo.value = "";
  el.btnProcesar.disabled = true;
});
el.btnInsertar.addEventListener("click", confirmarInsercion);

// ---------- Inicialización ----------

document.addEventListener("DOMContentLoaded", cargarEstado);
