"use strict";

const CATEGORIAS = [
  "Combustible",
  "Hospedaje",
  "Alimentación",
  "Descargue",
  "Otros (Peajes, Transporte, Parqueaderos)",
];

const STORAGE_KEY = "santaCatalinaGastosViaje_v1";
// Las funciones serverless de Vercel limitan el cuerpo de la petición a 4.5MB;
// en base64 eso equivale a ~3MB de archivo original. Al correr con server.js
// (Express) localmente ese límite no aplica y se puede subir si hace falta.
const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3MB

const state = {
  header: {
    conductor: "",
    placa: "",
    ruta: "",
    fechaInicio: "",
    fechaRetorno: "",
    kmInicial: "",
    kmFinal: "",
    saldoAnterior: "",
  },
  gastos: [], // { id, fecha, concepto, categoria, numeroRecibo, galones, precioGalon, valor, observaciones }
  anticipos: [], // { id, fecha, valor, observaciones }
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
  btnExportarExcel: document.getElementById("btnExportarExcel"),
  rendimientoCombustible: document.getElementById("rendimientoCombustible"),

  saldoAnterior: document.getElementById("saldoAnterior"),
  resumenSaldoAnterior: document.getElementById("resumenSaldoAnterior"),
  resumenAnticipos: document.getElementById("resumenAnticipos"),
  resumenGastos: document.getElementById("resumenGastos"),
  resumenSaldoFinal: document.getElementById("resumenSaldoFinal"),
  resumenEtiqueta: document.getElementById("resumenEtiqueta"),
  tablaAnticipos: document.getElementById("tablaAnticipos"),
  btnAgregarAnticipo: document.getElementById("btnAgregarAnticipo"),

  dropzone: document.getElementById("dropzone"),
  dropzoneTexto: document.getElementById("dropzoneTexto"),

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

  const esCombustible = gasto.categoria === "Combustible";

  const tdFecha = document.createElement("td");
  tdFecha.appendChild(crearInput("fecha", "date", gasto.fecha));

  const tdConcepto = document.createElement("td");
  tdConcepto.appendChild(crearInput("concepto", "text", gasto.concepto));

  const tdCategoria = document.createElement("td");
  tdCategoria.appendChild(crearSelectCategoria(gasto.categoria));

  const tdRecibo = document.createElement("td");
  tdRecibo.appendChild(crearInput("numeroRecibo", "text", gasto.numeroRecibo));

  const tdGalones = document.createElement("td");
  const inputGalones = crearInput("galones", "text", gasto.galones ? String(gasto.galones) : "");
  inputGalones.inputMode = "decimal";
  inputGalones.disabled = !esCombustible;
  tdGalones.appendChild(inputGalones);

  const tdPrecioGalon = document.createElement("td");
  const inputPrecioGalon = crearInput(
    "precioGalon",
    "text",
    gasto.precioGalon ? String(gasto.precioGalon) : ""
  );
  inputPrecioGalon.inputMode = "decimal";
  inputPrecioGalon.disabled = !esCombustible;
  tdPrecioGalon.appendChild(inputPrecioGalon);

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

  tr.append(tdFecha, tdConcepto, tdCategoria, tdRecibo, tdGalones, tdPrecioGalon, tdValor, tdObs, tdAcciones);
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
    galones: gastoParcial.galones ? parseCopAmount(gastoParcial.galones) : "",
    precioGalon: gastoParcial.precioGalon || gastoParcial.precio_galon
      ? parseCopAmount(gastoParcial.precioGalon ?? gastoParcial.precio_galon)
      : "",
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
    return;
  }
  if (field === "galones" || field === "precioGalon") {
    gasto[field] = parseCopAmount(rawValue);
    if (gasto.categoria === "Combustible" && gasto.galones && gasto.precioGalon) {
      gasto.valor = Math.round(gasto.galones * gasto.precioGalon);
      const tr = el.tablaGastos.querySelector(`tr[data-id="${id}"]`);
      const inputValor = tr && tr.querySelector('input[data-field="valor"]');
      if (inputValor) inputValor.value = String(gasto.valor);
    }
    return;
  }
  if (field === "categoria") {
    gasto.categoria = rawValue;
    const esCombustible = rawValue === "Combustible";
    const tr = el.tablaGastos.querySelector(`tr[data-id="${id}"]`);
    if (tr) {
      const inputGalones = tr.querySelector('input[data-field="galones"]');
      const inputPrecioGalon = tr.querySelector('input[data-field="precioGalon"]');
      if (inputGalones) inputGalones.disabled = !esCombustible;
      if (inputPrecioGalon) inputPrecioGalon.disabled = !esCombustible;
      if (!esCombustible) {
        if (inputGalones) inputGalones.value = "";
        if (inputPrecioGalon) inputPrecioGalon.value = "";
      }
    }
    if (!esCombustible) {
      gasto.galones = "";
      gasto.precioGalon = "";
    }
    return;
  }
  gasto[field] = rawValue;
}

// ---------- Anticipos ----------

function renderFilaAnticipo(anticipo) {
  const tr = document.createElement("tr");
  tr.dataset.id = anticipo.id;

  const tdFecha = document.createElement("td");
  tdFecha.appendChild(crearInput("fecha", "date", anticipo.fecha));

  const tdValor = document.createElement("td");
  const inputValor = crearInput("valor", "text", anticipo.valor ? String(anticipo.valor) : "");
  inputValor.classList.add("input-valor");
  inputValor.inputMode = "decimal";
  tdValor.appendChild(inputValor);

  const tdObs = document.createElement("td");
  tdObs.appendChild(crearInput("observaciones", "text", anticipo.observaciones));

  const tdAcciones = document.createElement("td");
  tdAcciones.classList.add("col-acciones");
  const btnEliminar = document.createElement("button");
  btnEliminar.type = "button";
  btnEliminar.className = "btn-eliminar-anticipo";
  btnEliminar.textContent = "✕";
  btnEliminar.title = "Eliminar anticipo";
  tdAcciones.appendChild(btnEliminar);

  tr.append(tdFecha, tdValor, tdObs, tdAcciones);
  return tr;
}

function renderTablaAnticipos() {
  el.tablaAnticipos.innerHTML = "";
  for (const anticipo of state.anticipos) {
    el.tablaAnticipos.appendChild(renderFilaAnticipo(anticipo));
  }
}

function agregarAnticipo(parcial = {}) {
  const anticipo = {
    id: uid(),
    fecha: parcial.fecha || "",
    valor: parseCopAmount(parcial.valor),
    observaciones: parcial.observaciones || "",
  };
  state.anticipos.push(anticipo);
  el.tablaAnticipos.appendChild(renderFilaAnticipo(anticipo));
  calculateTripForm();
  return anticipo;
}

function eliminarAnticipo(id) {
  state.anticipos = state.anticipos.filter((a) => a.id !== id);
  const tr = el.tablaAnticipos.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.remove();
  calculateTripForm();
}

function actualizarAnticipo(id, field, rawValue) {
  const anticipo = state.anticipos.find((a) => a.id === id);
  if (!anticipo) return;
  anticipo[field] = field === "valor" ? parseCopAmount(rawValue) : rawValue;
}

// ---------- Cálculos de la planilla ----------

function calculateTripForm() {
  const kmInicial = parseFloat(el.kmInicial.value);
  const kmFinal = parseFloat(el.kmFinal.value);
  let kmTotalNum = null;
  if (Number.isFinite(kmInicial) && Number.isFinite(kmFinal) && kmFinal >= kmInicial) {
    kmTotalNum = kmFinal - kmInicial;
    el.kmTotal.value = `${kmTotalNum} km`;
  } else {
    el.kmTotal.value = "";
  }

  const totalGastos = state.gastos.reduce((sum, g) => sum + (Number(g.valor) || 0), 0);
  el.totalGeneral.textContent = formatCOP(totalGastos);

  const totalGalones = state.gastos
    .filter((g) => g.categoria === "Combustible")
    .reduce((sum, g) => sum + (Number(g.galones) || 0), 0);
  if (kmTotalNum && totalGalones > 0) {
    el.rendimientoCombustible.textContent = `Rendimiento: ${(kmTotalNum / totalGalones).toFixed(2)} km/galón (${totalGalones} gal totales)`;
  } else {
    el.rendimientoCombustible.textContent = "";
  }

  const totalAnticipos = state.anticipos.reduce((sum, a) => sum + (Number(a.valor) || 0), 0);
  const saldoAnterior = parseCopAmount(el.saldoAnterior.value);
  const saldoFinal = saldoAnterior + totalAnticipos - totalGastos;

  el.resumenSaldoAnterior.textContent = formatCOP(saldoAnterior);
  el.resumenAnticipos.textContent = formatCOP(totalAnticipos);
  el.resumenGastos.textContent = formatCOP(totalGastos);
  el.resumenSaldoFinal.textContent = formatCOP(saldoFinal);
  el.resumenSaldoFinal.classList.toggle("saldo-positivo", saldoFinal > 0);
  el.resumenSaldoFinal.classList.toggle("saldo-negativo", saldoFinal < 0);

  if (saldoFinal > 0) {
    el.resumenEtiqueta.textContent = "A favor de la empresa (el conductor debe reembolsar este valor).";
  } else if (saldoFinal < 0) {
    el.resumenEtiqueta.textContent = "A favor del conductor (la empresa debe reembolsar este valor).";
  } else {
    el.resumenEtiqueta.textContent = "Cuenta saldada.";
  }

  guardarEstado();
}

// ---------- Exportar a Excel (.xlsx) ----------

function exportarExcel() {
  if (typeof XLSX === "undefined") {
    mostrarError("No se pudo cargar la librería de Excel. Verifica tu conexión e intenta de nuevo.");
    return;
  }

  const filasEncabezado = [
    ["Panificadora Santa Catalina S.A.S. - Liquidación de Gastos de Viaje"],
    [],
    ["Conductor", el.conductor.value, "Placa", el.placa.value],
    ["Ruta", el.ruta.value],
    ["Fecha Inicio", el.fechaInicio.value, "Fecha Retorno", el.fechaRetorno.value],
    ["Km Inicial", el.kmInicial.value, "Km Final", el.kmFinal.value, "Km Total", el.kmTotal.value],
    [],
  ];

  const encabezadoGastos = [
    "Fecha",
    "Concepto",
    "Categoría",
    "No. Recibo",
    "Galones",
    "$/Galón",
    "Valor",
    "Observaciones",
  ];
  const filasGastos = state.gastos.map((g) => [
    g.fecha,
    g.concepto,
    g.categoria,
    g.numeroRecibo,
    g.galones || "",
    g.precioGalon || "",
    g.valor,
    g.observaciones,
  ]);
  const totalGastos = state.gastos.reduce((sum, g) => sum + (Number(g.valor) || 0), 0);

  const encabezadoAnticipos = ["Fecha", "Valor", "Observaciones"];
  const filasAnticipos = state.anticipos.map((a) => [a.fecha, a.valor, a.observaciones]);
  const totalAnticipos = state.anticipos.reduce((sum, a) => sum + (Number(a.valor) || 0), 0);

  const saldoAnterior = parseCopAmount(el.saldoAnterior.value);
  const saldoFinal = saldoAnterior + totalAnticipos - totalGastos;

  const filas = [
    ...filasEncabezado,
    encabezadoGastos,
    ...filasGastos,
    ["", "", "", "", "", "", "TOTAL GASTOS", totalGastos],
    [],
    ["Anticipos Entregados"],
    encabezadoAnticipos,
    ...filasAnticipos,
    ["", "", "TOTAL ANTICIPOS", totalAnticipos],
    [],
    ["Liquidación"],
    ["Saldo anterior", saldoAnterior],
    ["(+) Anticipos entregados", totalAnticipos],
    ["(-) Total gastos operativos", totalGastos],
    ["Saldo final", saldoFinal],
  ];

  const hoja = XLSX.utils.aoa_to_sheet(filas);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Liquidación");

  const placa = (el.placa.value || "sin-placa").replace(/[^a-zA-Z0-9-]/g, "");
  const fecha = el.fechaInicio.value || new Date().toISOString().slice(0, 10);
  XLSX.writeFile(libro, `liquidacion-viaje-${placa}-${fecha}.xlsx`);
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
      galones: g.galones,
      precioGalon: g.precio_galon,
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
    saldoAnterior: el.saldoAnterior.value,
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
    state.anticipos = Array.isArray(guardado.anticipos) ? guardado.anticipos : [];
  }

  el.conductor.value = state.header.conductor || "";
  el.placa.value = state.header.placa || "";
  el.ruta.value = state.header.ruta || "";
  el.fechaInicio.value = state.header.fechaInicio || "";
  el.fechaRetorno.value = state.header.fechaRetorno || "";
  el.kmInicial.value = state.header.kmInicial || "";
  el.kmFinal.value = state.header.kmFinal || "";
  el.saldoAnterior.value = state.header.saldoAnterior || "";

  renderTabla();
  renderTablaAnticipos();
  if (state.gastos.length === 0) agregarFila();
  calculateTripForm();
}

// ---------- Modal OCR ----------

function abrirModal() {
  el.modalOverlay.hidden = false;
  mostrarPasoOcr("upload");
  el.inputArchivo.value = "";
  el.btnProcesar.disabled = true;
  actualizarTextoDropzone();
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
    mostrarError("El archivo supera el tamaño máximo permitido (3MB).");
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
  if (field === "valor" || field === "galones" || field === "precioGalon") calculateTripForm();
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

[el.kmInicial, el.kmFinal, el.saldoAnterior].forEach((input) => {
  input.addEventListener("input", calculateTripForm);
});

[el.conductor, el.placa, el.ruta, el.fechaInicio, el.fechaRetorno].forEach((input) => {
  input.addEventListener("input", guardarEstado);
});

el.btnAgregarFila.addEventListener("click", () => agregarFila());

el.tablaAnticipos.addEventListener("input", (event) => {
  const tr = event.target.closest("tr");
  if (!tr) return;
  const field = event.target.dataset.field;
  if (!field) return;
  actualizarAnticipo(tr.dataset.id, field, event.target.value);
  if (field === "valor") calculateTripForm();
  else guardarEstado();
});

el.tablaAnticipos.addEventListener("click", (event) => {
  if (event.target.classList.contains("btn-eliminar-anticipo")) {
    const tr = event.target.closest("tr");
    if (tr) eliminarAnticipo(tr.dataset.id);
  }
});

el.btnAgregarAnticipo.addEventListener("click", () => agregarAnticipo());

el.btnImprimir.addEventListener("click", () => window.print());

el.btnExportarExcel.addEventListener("click", exportarExcel);

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
  actualizarTextoDropzone();
  ocultarError();
});

["dragenter", "dragover"].forEach((evento) => {
  el.dropzone.addEventListener(evento, (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dropzone-activo");
  });
});

["dragleave", "drop"].forEach((evento) => {
  el.dropzone.addEventListener(evento, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove("dropzone-activo");
  });
});

el.dropzone.addEventListener("drop", (event) => {
  const archivo = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!archivo) return;
  el.inputArchivo.files = event.dataTransfer.files;
  el.btnProcesar.disabled = false;
  actualizarTextoDropzone();
  ocultarError();
});

function actualizarTextoDropzone() {
  const archivo = el.inputArchivo.files && el.inputArchivo.files[0];
  el.dropzoneTexto.textContent = archivo
    ? archivo.name
    : "Arrastra el archivo aquí o haz clic para elegirlo";
}

el.btnProcesar.addEventListener("click", procesarDocumento);
el.btnVolverSubir.addEventListener("click", () => {
  mostrarPasoOcr("upload");
  el.inputArchivo.value = "";
  el.btnProcesar.disabled = true;
  actualizarTextoDropzone();
});
el.btnInsertar.addEventListener("click", confirmarInsercion);

// ---------- Inicialización ----------

document.addEventListener("DOMContentLoaded", cargarEstado);
