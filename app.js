/* =========================================================================
   SISTEMA JCLIP PRO ULTRA - LÓGICA V22 (VERSIÓN INTEGRAL Y COMPLETA)
   ========================================================================= */

const BASE_URL = window.location.origin; 
const API = `${BASE_URL}/api`;
let currentChartVentas = null;

// Canal de Comunicación en Tiempo Real para Pantalla Secundaria del Cliente
const posChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('jclip_pos') : null;

function escapeHTML(str) {
    if(!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag]));
}

function round2(num) { return Math.round((num + Number.EPSILON) * 100) / 100; }

// Función de Conexión HTTP Unificada (Siempre Adjunta Token JWT)
async function fetchAPI(endpoint, options = {}) {
    const token = localStorage.getItem('jc_token');
    if(!options.headers) options.headers = {};
    
    if(token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    if(!(options.body instanceof FormData) && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
    }
    
    try {
        const res = await fetch(API + endpoint, options);
        if(res.status === 401 || res.status === 403) {
            App.auth.logout(false);
            throw new Error("Privilegios insuficientes o sesión expirada");
        }
        if(!res.ok) {
            const err = await res.json().catch(() => ({ detail: "Error en el servidor" }));
            throw new Error(err.detail || "Error interno del servidor");
        }
        return res;
    } catch (e) {
        App.ui.toast(e.message || "Falla de red con el servidor", "error");
        throw e; 
    }
}

function extractDominantColor(imgElement) {
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
    canvas.width = imgElement.naturalWidth || imgElement.width; canvas.height = imgElement.naturalHeight || imgElement.height;
    context.drawImage(imgElement, 0, 0);
    try {
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let r=0, g=0, b=0, count=0;
        for(let i=0; i<data.length; i+=4) { if(data[i+3] > 127) { r += data[i]; g += data[i+1]; b += data[i+2]; count++; } }
        if(count > 0) { r = Math.floor(r/count); g = Math.floor(g/count); b = Math.floor(b/count); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); }
    } catch(e) { } return null;
}

// =========================================================================
// OBJETO PRINCIPAL APP
// =========================================================================
const App = {
    state: {
        usuario: null, 
        config: { tasa: 38.50, telefono: "", pts: 1, color: "#845EC2", logo_url: "", plantilla_url: "", removebg_key: "", nombre_sistema: "JCLIP", fuente: "'Plus Jakarta Sans'", fuente_url: "" },
        productos: [], proveedores: [], clientes: [], usuarios: [], categorias: [], bitacora: [],
        carrito: [], clienteActual: null, pausadas: [], prodEtiqueta: null,
        subtotal: 0, descPorc: 0, ivaPorc: 16, puntosACanjear: 0, isMixto: false, theme: 'liquid',
        costoEnvio: 0.0, tipoEntrega: 'MOSTRADOR', motorizado: '',
        turnoActivo: null, pedidos: [], kardex: [],
        comboEditComponentes: [], pedidoFormItems: []
    },

    init: async function() {
        const savedTheme = localStorage.getItem('jc_theme') || 'liquid';
        this.ui.applyTheme(savedTheme);
        const toggle = document.getElementById('theme-toggle'); if(toggle) toggle.checked = (savedTheme === 'liquid');

        this.bindEvents();
        await this.config.load();
        
        const token = localStorage.getItem('jc_token'); const userData = localStorage.getItem('jc_user');
        if(token && userData) { this.state.usuario = JSON.parse(userData); this.auth.applySession(); }
        
        this.tutor.init();
    },

    bindEvents: function() {
        // Lector de Código de Barras Global (Hardware / Pistola USB & Bluetooth)
        let barcodeBuffer = '';
        let lastKeyTime = Date.now();

        document.addEventListener('keydown', (e) => {
            if(document.getElementById('lightbox-modal').style.display === 'flex' && e.key === 'Escape') {
                App.ui.closeLightbox(); return;
            }

            const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
            
            // Detección de buffer rápido de pistola lectora (velocidad < 60ms entre caracteres)
            const now = Date.now();
            if(now - lastKeyTime > 120) { barcodeBuffer = ''; }
            lastKeyTime = now;

            if(!isInputFocused) {
                if(e.key === "F2") { e.preventDefault(); switchTab('inventario'); document.getElementById('buscador').focus(); return; }
                if(e.key === "F4") { e.preventDefault(); let c = document.getElementById('modal-caja-flotante'); if(c) c.style.display === 'flex' ? c.style.display = 'none' : abrirCajaFacturacion(); return; }

                if(e.key.length === 1) {
                    barcodeBuffer += e.key;
                } else if(e.key === "Enter" && barcodeBuffer.length >= 3) {
                    e.preventDefault();
                    const skuBuscado = barcodeBuffer.trim();
                    const prodMatch = App.state.productos.find(p => p.codigo && p.codigo.toLowerCase() === skuBuscado.toLowerCase());
                    if(prodMatch) {
                        App.pos.add(prodMatch.id);
                        App.ui.toast(`⚡ Escaneado por Pistola: ${prodMatch.nombre}`, "success");
                    } else {
                        App.ui.toast(`Código no encontrado: ${skuBuscado}`, "warning");
                    }
                    barcodeBuffer = '';
                }
            }
        });
    },

    config: {
        load: async function() {
            try {
                const res = await fetch(`${API}/config`);
                if (res.ok) {
                    App.state.config = await res.json();
                    
                    // CARGAR TIPOGRAFÍA PERSONALIZADA O DE GOOGLE
                    if(App.state.config.fuente_url) {
                        let fontStyle = document.getElementById('custom-uploaded-font-style');
                        if(!fontStyle) {
                            fontStyle = document.createElement('style');
                            fontStyle.id = 'custom-uploaded-font-style';
                            document.head.appendChild(fontStyle);
                        }
                        fontStyle.textContent = `@font-face { font-family: 'JclipCustomFont'; src: url('${App.state.config.fuente_url}'); } body, input, button, select, textarea { font-family: 'JclipCustomFont', sans-serif !important; }`;
                    } else if(App.state.config.fuente) {
                        document.documentElement.style.setProperty('--font-family', App.state.config.fuente);
                        let cFont = document.getElementById('config-fuente'); if(cFont) cFont.value = App.state.config.fuente;
                    }

                    // CARGAR NOMBRE DEL SISTEMA
                    if(App.state.config.nombre_sistema) {
                        document.title = App.state.config.nombre_sistema + " - ERP";
                        let dName = document.getElementById('display-nombre-sistema'); if(dName) dName.innerText = App.state.config.nombre_sistema;
                        let cName = document.getElementById('config-nombre-sistema'); if(cName) cName.value = App.state.config.nombre_sistema;
                        let sName = document.getElementById('splash-nombre-sistema'); if(sName) sName.innerText = App.state.config.nombre_sistema;
                    }

                    if(document.getElementById('header-tasa-display')) document.getElementById('header-tasa-display').innerText = `Tasa: $1.00 = Bs.${App.state.config.tasa.toFixed(2)}`;
                    if(document.getElementById('config-tasa')) document.getElementById('config-tasa').value = App.state.config.tasa;
                    if(document.getElementById('config-removebg-key')) document.getElementById('config-removebg-key').value = App.state.config.removebg_key || '';
                    
                    if(App.state.config.color) { 
                        document.documentElement.style.setProperty('--primary', App.state.config.color); 
                        document.body.style.setProperty('--primary', App.state.config.color);
                        if(document.getElementById('config-color')) document.getElementById('config-color').value = App.state.config.color; 
                    }
                    
                    if(App.state.config.logo_url) { 
                        let fullUrl = App.state.config.logo_url.startsWith('http') ? App.state.config.logo_url : BASE_URL + App.state.config.logo_url; 
                        let logoImg = document.getElementById('brand-logo'); 
                        if(logoImg) { logoImg.src = fullUrl; logoImg.style.display = 'block'; logoImg.nextElementSibling.style.display = 'none'; } 
                        
                        let fav = document.getElementById('favicon');
                        if(fav) fav.href = fullUrl;
                    }
                    
                    if(App.state.config.plantilla_url) {
                        let fUrl = App.state.config.plantilla_url.startsWith('http') ? App.state.config.plantilla_url : BASE_URL + App.state.config.plantilla_url;
                        let prev = document.getElementById('config-plantilla-preview');
                        if(prev) { prev.src = fUrl; prev.style.display = 'block'; }
                    }
                }
            } catch(e) {}
        },
        guardar: async function(e) {
            e.preventDefault();
            let nt = parseFloat(document.getElementById('config-tasa').value); 
            let nc = document.getElementById('config-color').value; 
            let rkey = document.getElementById('config-removebg-key').value;
            let ns = document.getElementById('config-nombre-sistema').value || 'JCLIP';
            let fnt = document.getElementById('config-fuente').value || "'Plus Jakarta Sans'";
            let file = document.getElementById('config-logo').files[0];
            let plantilla_file = document.getElementById('config-plantilla').files[0];
            let fuente_file = document.getElementById('config-fuente-file') ? document.getElementById('config-fuente-file').files[0] : null;
            
            if(nt <= 0) return App.ui.toast("Tasa inválida", "error");
            
            const fd = new FormData(); 
            fd.append("tasa", nt); 
            fd.append("color", nc); 
            fd.append("removebg_key", rkey);
            fd.append("nombre_sistema", ns);
            fd.append("fuente", fnt);
            if(file) fd.append("logo", file);
            if(plantilla_file) fd.append("plantilla", plantilla_file);
            if(fuente_file) fd.append("archivo_fuente", fuente_file);
            
            try { 
                await fetchAPI('/config', {method:"POST", body:fd}); 
                App.ui.toast("Configuración guardada exitosamente", "success"); 
                setTimeout(() => location.reload(), 1000); 
            } catch(err) {}
        },
        syncBCV: async function() {
            App.ui.toast("Consultando tasa oficial BCV en vivo...", "info");
            try {
                const res = await fetchAPI('/config/sync_bcv', {method: "POST"});
                const data = await res.json();
                App.state.config.tasa = data.tasa;
                document.getElementById('header-tasa-display').innerText = `Tasa: $1.00 = Bs.${data.tasa.toFixed(2)}`;
                if(document.getElementById('config-tasa')) document.getElementById('config-tasa').value = data.tasa;
                App.ui.toast("¡Tasa BCV Actualizada Exitosamente!", "success");
                actualizarVista(); 
            } catch(e) { }
        },
        clickTasaHeader: function() {
            if(App.state.usuario && App.state.usuario.rol === 'superadmin') {
                document.getElementById('modal-ajustes').style.display='flex';
            } else {
                App.ui.toast("Solo el dueño del sistema puede editar la configuración general.", "warning");
            }
        }
    },

    auth: {
        login: async function() {
            const usuario = document.getElementById('input-usuario-login').value; const pin = document.getElementById('input-pin-login').value;
            if(!usuario || !pin) return App.ui.toast("Ingrese usuario y PIN", "warning");
            try {
                const res = await fetch(`${API}/auth`, { method: "POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({usuario, pin}) });
                if(res.ok) {
                    const data = await res.json();
                    localStorage.setItem('jc_token', data.token); localStorage.setItem('jc_user', JSON.stringify(data.user));
                    App.state.usuario = data.user; this.applySession(); App.ui.toast(`Bienvenido ${data.user.nombre}`, "success");
                } else { 
                    const err = await res.json().catch(() => ({ detail: "Usuario o PIN Incorrecto" }));
                    document.getElementById('login-error').innerText = err.detail || "Usuario o PIN Incorrecto"; 
                    document.getElementById('login-error').style.display = 'block'; 
                }
            } catch(e) { App.ui.toast("Error de conexión con Backend", "error"); }
        },
        applySession: async function() {
            document.body.className = document.body.className.replace(/ (superadmin|admin|cajero|supervisor|user)-active /g, '');
            document.body.classList.add(`${App.state.usuario.rol}-active`); document.getElementById('modal-bienvenida').style.display = 'none';
            
            const hAvatar = document.getElementById('header-avatar');
            if(App.state.usuario.foto && hAvatar) { hAvatar.src = App.state.usuario.foto.startsWith('http') ? App.state.usuario.foto : BASE_URL + App.state.usuario.foto; }
            
            const hName = document.getElementById('header-user-name');
            if(hName) { hName.innerText = App.state.usuario.nombre; hName.style.display = 'block'; }
            
            await App.categorias.load(); await App.proveedores.load(); await App.inv.load();
            await App.turnos.checkActivo();
            if(App.state.usuario.rol !== 'cajero') { 
                await App.crm.load(); 
                await App.stats.load(); 
                await App.pedidos.load();
            } else { 
                document.getElementById('nav-tab-inicio').style.display = 'none'; 
                switchTab('inventario'); 
            }
        },
        visitante: function() {
            document.body.className = document.body.className.replace(/ (superadmin|admin|cajero|supervisor|user)-active /g, '');
            document.body.classList.add('user-active'); document.getElementById('modal-bienvenida').style.display = 'none'; document.getElementById('nav-tab-inicio').style.display = 'none'; document.getElementById('nav-tab-caja').style.display = 'none';
            App.state.usuario = { nombre: "Visitante", rol: "user" }; 
            const hName = document.getElementById('header-user-name'); if(hName) { hName.innerText = "Catálogo Público"; hName.style.display = 'block'; }
            switchTab('inventario'); App.inv.load();
        },
        logout: function(reload=true) { 
            localStorage.removeItem('jc_token'); localStorage.removeItem('jc_user'); 
            if(reload) location.reload(); else document.getElementById('modal-bienvenida').style.display = 'flex';
        }
    },

    categorias: {
        load: async function() { try { const res = await fetchAPI('/categorias'); const data = await res.json(); App.state.categorias = data; this.renderPills(); } catch(e) { } },
        renderPills: function() {
            const container = document.getElementById('category-pills'); const sel = document.getElementById('categoria-select');
            if(container) {
                let html = `<div class="category-pill active" onclick="App.categorias.filtrar('Todas', this)">Todos</div>`;
                App.state.categorias.forEach(c => { html += `<div class="category-pill" onclick="App.categorias.filtrar('${escapeHTML(c.nombre)}', this)">${escapeHTML(c.nombre)}</div>`; });
                container.innerHTML = html;
            }
            if(sel) sel.innerHTML = `<option value="General">Categoría General</option>` + App.state.categorias.map(c => `<option value="${escapeHTML(c.nombre)}">${escapeHTML(c.nombre)}</option>`).join('');
        },
        filtrar: function(catName, element) {
            document.querySelectorAll('.category-pill').forEach(btn => btn.classList.remove('active')); element.classList.add('active');
            if(catName === 'Todas') { App.inv.render(App.state.productos); } else { App.inv.render(App.state.productos.filter(p => p.categoria === catName)); }
        },
        agregarNueva: async function() {
            const nom = prompt("Escribe el nombre de la nueva categoría:"); if(!nom) return;
            const fd = new FormData(); fd.append("nombre", nom);
            try {
                await fetchAPI('/categorias', {method:"POST", body:fd}); await this.load(); 
                const sel = document.getElementById('categoria-select');
                if(sel) { const opt = document.createElement('option'); opt.value = nom; opt.innerText = nom; sel.appendChild(opt); sel.value = nom; }
                App.ui.toast("Categoría agregada", "success");
            } catch(e) {}
        }
    },

    scanner: {
        html5QrcodeScanner: null,
        init: function() {
            document.getElementById('modal-escaner').style.display = 'flex';
            if(!this.html5QrcodeScanner) this.html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 250} }, false);
            this.html5QrcodeScanner.render((text) => { document.getElementById('buscador').value = text; this.stop(); App.inv.filtrar(text); App.ui.toast("Código escaneado", "success"); }, (error) => {});
        },
        stop: function() { if(this.html5QrcodeScanner) { this.html5QrcodeScanner.clear(); } document.getElementById('modal-escaner').style.display = 'none'; }
    },

    // ==========================================
    // MÓDULO DE TURNOS Y APERTURA/CIERRE DE CAJA
    // ==========================================
    turnos: {
        checkActivo: async function() {
            try {
                const res = await fetchAPI('/turnos/activo');
                const t = await res.json();
                App.state.turnoActivo = t;
                const badge = document.getElementById('badge-turno-status');
                const txtTiempo = document.getElementById('txt-tiempo-turno');
                const btnToggle = document.getElementById('btn-turno-toggle');
                const dashFondo = document.getElementById('dash-fondo');

                if(t) {
                    if(badge) { badge.innerText = "ABIERTO"; badge.style.background = "var(--success-bg)"; badge.style.color = "var(--success)"; }
                    if(txtTiempo) txtTiempo.innerText = `Abierto por ${t.cajero} a las ${t.fecha_apertura.substring(11, 16)}`;
                    if(btnToggle) { btnToggle.innerHTML = `<i class="ph-bold ph-lock-key"></i> Cerrar Turno`; btnToggle.style.background = "var(--danger)"; btnToggle.onclick = () => App.turnos.abrirModalCierre(); }
                    if(dashFondo) dashFondo.innerText = `$${parseFloat(t.monto_inicial_usd || 0).toFixed(2)}`;
                } else {
                    if(badge) { badge.innerText = "CERRADO"; badge.style.background = "var(--danger-bg)"; badge.style.color = "var(--danger)"; }
                    if(txtTiempo) txtTiempo.innerText = "Sin turno abierto";
                    if(btnToggle) { btnToggle.innerHTML = `<i class="ph-bold ph-door-open"></i> Abrir Turno`; btnToggle.style.background = "var(--primary)"; btnToggle.onclick = () => App.turnos.abrirModalApertura(); }
                    if(dashFondo) dashFondo.innerText = "$0.00";
                }
            } catch(e) {}
        },
        abrirModalApertura: function() {
            document.getElementById('modal-apertura').style.display = 'flex';
        },
        ejecutarApertura: async function(e) {
            e.preventDefault();
            const req = {
                monto_inicial_usd: parseFloat(document.getElementById('apertura-usd').value) || 0.0,
                monto_inicial_bs: parseFloat(document.getElementById('apertura-bs').value) || 0.0,
                notas: document.getElementById('apertura-notas').value || ''
            };
            try {
                await fetchAPI('/turnos/abrir', { method: "POST", body: JSON.stringify(req) });
                App.ui.toast("¡Turno de caja abierto exitosamente!", "success");
                document.getElementById('modal-apertura').style.display = 'none';
                e.target.reset();
                await this.checkActivo();
                await App.stats.load();
            } catch(err) {}
        },
        abrirModalCierre: async function() {
            if(!App.state.turnoActivo) return App.ui.toast("No hay turno abierto", "warning");
            try {
                const resStats = await fetchAPI('/stats');
                const st = await resStats.json();
                const fondo = App.state.turnoActivo.monto_inicial_usd || 0.0;
                const ventas = st.ventas_hoy || 0.0;
                const gastos = st.gastos_hoy || 0.0;
                const esperado = round2(fondo + ventas - gastos);

                document.getElementById('cierre-prev-fondo').innerText = `$${fondo.toFixed(2)}`;
                document.getElementById('cierre-prev-ventas').innerText = `$${ventas.toFixed(2)}`;
                document.getElementById('cierre-prev-gastos').innerText = `-$${gastos.toFixed(2)}`;
                document.getElementById('cierre-prev-esperado').innerText = `$${esperado.toFixed(2)}`;
                document.getElementById('cierre-contado-usd').value = '';
                document.getElementById('cierre-diferencia-box').style.display = 'none';

                document.getElementById('modal-cierre-comparativo').style.display = 'flex';
            } catch(e) {}
        },
        calcDiferencia: function() {
            const esperado = parseFloat(document.getElementById('cierre-prev-esperado').innerText.replace('$','')) || 0.0;
            const contado = parseFloat(document.getElementById('cierre-contado-usd').value) || 0.0;
            const diff = round2(contado - esperado);
            const box = document.getElementById('cierre-diferencia-box');
            if(!box) return;

            box.style.display = 'block';
            if(diff > 0.01) {
                box.style.background = "rgba(16, 185, 129, 0.2)";
                box.style.color = "var(--success)";
                box.innerText = `Sobrante en caja: +$${diff.toFixed(2)}`;
            } else if(diff < -0.01) {
                box.style.background = "rgba(239, 68, 68, 0.2)";
                box.style.color = "var(--danger)";
                box.innerText = `Faltante / Descuadre: -$${Math.abs(diff).toFixed(2)}`;
            } else {
                box.style.background = "rgba(16, 185, 129, 0.2)";
                box.style.color = "var(--success)";
                box.innerText = "¡Cuadre Perfecto ($0.00 de diferencia)!";
            }
        },
        ejecutarCierreComparativo: async function(e) {
            e.preventDefault();
            const req = {
                contado_usd: parseFloat(document.getElementById('cierre-contado-usd').value) || 0.0,
                contado_bs: 0.0,
                notas: document.getElementById('cierre-notas').value || ''
            };
            try {
                const res = await fetchAPI('/turnos/cerrar', { method: "POST", body: JSON.stringify(req) });
                const d = await res.json();
                App.ui.toast(`Turno cerrado. Diferencia: $${d.diferencia_usd}`, "success");
                document.getElementById('modal-cierre-comparativo').style.display = 'none';
                e.target.reset();
                await this.checkActivo();
                await App.stats.load();
            } catch(err) {}
        }
    },

    // ==========================================
    // MÓDULO DE KARDEX Y TRAZABILIDAD
    // ==========================================
    kardex: {
        load: async function(producto_id = null) {
            try {
                let url = '/kardex';
                if(producto_id) url += `?producto_id=${producto_id}`;
                const res = await fetchAPI(url);
                const data = await res.json();
                App.state.kardex = data;

                const sel = document.getElementById('kardex-filtro-prod');
                if(sel) {
                    sel.innerHTML = `<option value="">Todos los productos</option>` + App.state.productos.map(p => `<option value="${p.id}" ${producto_id == p.id ? 'selected' : ''}>${escapeHTML(p.nombre)}</option>`).join('');
                }

                const container = document.getElementById('kardex-table-container');
                if(container) {
                    if(data.length === 0) {
                        container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">No hay movimientos registrados en el Kardex.</div>`;
                    } else {
                        container.innerHTML = `
                            <table class="kardex-table">
                                <thead>
                                    <tr>
                                        <th>Fecha</th>
                                        <th>Producto</th>
                                        <th>Tipo Movimiento</th>
                                        <th>Cantidad</th>
                                        <th>Previo</th>
                                        <th>Nuevo Stock</th>
                                        <th>Costo Unit.</th>
                                        <th>Motivo / Folio</th>
                                        <th>Usuario</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${data.map(k => {
                                        let badgeClass = 'kardex-tipo-ajuste';
                                        if(k.tipo.includes('VENTA')) badgeClass = 'kardex-tipo-venta';
                                        else if(k.tipo.includes('COMPRA')) badgeClass = 'kardex-tipo-compra';
                                        else if(k.tipo.includes('MERMA') || k.tipo.includes('BAJA')) badgeClass = 'kardex-tipo-merma';

                                        return `
                                            <tr>
                                                <td style="white-space:nowrap;">${k.fecha}</td>
                                                <td><strong>${escapeHTML(k.producto_nombre)}</strong></td>
                                                <td><span class="kardex-tipo-badge ${badgeClass}">${escapeHTML(k.tipo)}</span></td>
                                                <td style="font-weight:bold;">${k.cantidad}</td>
                                                <td>${k.stock_previo}</td>
                                                <td style="font-weight:bold; color:var(--primary);">${k.stock_nuevo}</td>
                                                <td>$${(k.costo_unitario || 0).toFixed(2)}</td>
                                                <td>${escapeHTML(k.motivo || '')}</td>
                                                <td><small>${escapeHTML(k.usuario)}</small></td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        `;
                    }
                }
                document.getElementById('modal-kardex').style.display = 'flex';
            } catch(e) {}
        },
        filtrarPorProducto: function(prodId) {
            this.load(prodId ? parseInt(prodId) : null);
        },
        exportarCSV: function() {
            if(App.state.kardex.length === 0) return App.ui.toast("No hay datos de Kardex para exportar", "warning");
            let rows = [["ID", "Fecha", "Producto", "Tipo", "Cantidad", "Stock Previo", "Stock Nuevo", "Costo Unit", "Motivo", "Usuario"]];
            App.state.kardex.forEach(k => rows.push([k.id, k.fecha, k.producto_nombre, k.tipo, k.cantidad, k.stock_previo, k.stock_nuevo, k.costo_unitario, k.motivo, k.usuario]));
            let csv = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
            const link = document.createElement("a");
            link.setAttribute("href", encodeURI(csv));
            link.setAttribute("download", `Kardex_JCLIP_${new Date().toISOString().slice(0,10)}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            App.ui.toast("Kardex exportado a CSV", "success");
        }
    },

    // ==========================================
    // MÓDULO DE MERMAS Y AJUSTES DE STOCK
    // ==========================================
    mermas: {
        abrirModal: function() {
            const sel = document.getElementById('merma-prod-id');
            if(sel) {
                sel.innerHTML = App.state.productos.filter(p => !p.es_combo).map(p => `<option value="${p.id}">${escapeHTML(p.nombre)} (Stock actual: ${p.stock})</option>`).join('');
            }
            document.getElementById('modal-merma').style.display = 'flex';
        },
        guardarForm: async function(e) {
            e.preventDefault();
            const req = {
                producto_id: parseInt(document.getElementById('merma-prod-id').value),
                cantidad: parseFloat(document.getElementById('merma-cantidad').value) || 0,
                motivo: document.getElementById('merma-motivo').value
            };
            if(req.cantidad <= 0) return App.ui.toast("Cantidad inválida", "error");
            try {
                await fetchAPI('/mermas', { method: "POST", body: JSON.stringify(req) });
                App.ui.toast("Merma registrada y stock descontado", "success");
                document.getElementById('modal-merma').style.display = 'none';
                e.target.reset();
                await App.inv.load();
            } catch(err) {}
        }
    },

    // ==========================================
    // MÓDULO DE COMBOS Y KITS
    // ==========================================
    combos: {
        toggleUI: function(isCombo) {
            const area = document.getElementById('area-combo-config');
            if(area) area.style.display = isCombo ? 'block' : 'none';
            if(isCombo) this.populateSelect();
        },
        populateSelect: function() {
            const sel = document.getElementById('combo-prod-select');
            if(sel) {
                sel.innerHTML = App.state.productos.filter(p => !p.es_combo).map(p => `<option value="${p.id}">${escapeHTML(p.nombre)} ($${p.precio})</option>`).join('');
            }
        },
        agregarComponente: function() {
            const sel = document.getElementById('combo-prod-select');
            const qtyInput = document.getElementById('combo-prod-qty');
            if(!sel || !qtyInput) return;

            const prodId = parseInt(sel.value);
            const qty = parseFloat(qtyInput.value) || 1;
            const p = App.state.productos.find(x => x.id === prodId);
            if(!p) return;

            const exist = App.state.comboEditComponentes.find(c => c.id === prodId);
            if(exist) {
                exist.cantidad += qty;
            } else {
                App.state.comboEditComponentes.push({ id: p.id, nombre: p.nombre, cantidad: qty, precio: p.precio });
            }
            this.renderComponentes();
        },
        eliminarComponente: function(idx) {
            App.state.comboEditComponentes.splice(idx, 1);
            this.renderComponentes();
        },
        renderComponentes: function() {
            const container = document.getElementById('combo-componentes-lista-ui');
            if(!container) return;
            if(App.state.comboEditComponentes.length === 0) {
                container.innerHTML = '<span style="color:var(--text-muted);">Sin componentes añadidos aún.</span>';
                return;
            }
            container.innerHTML = App.state.comboEditComponentes.map((c, idx) => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border-color);">
                    <span>${c.cantidad}x <strong>${escapeHTML(c.nombre)}</strong></span>
                    <button type="button" onclick="App.combos.eliminarComponente(${idx})" style="background:transparent; border:none; color:var(--danger); cursor:pointer;"><i class="ph-bold ph-trash"></i></button>
                </div>
            `).join('');
        }
    },

    // ==========================================
    // MÓDULO DE PEDIDOS OMNICANAL (TABLERO KANBAN & DELIVERY)
    // ==========================================
    pedidos: {
        load: async function() {
            try {
                const res = await fetchAPI('/pedidos');
                const data = await res.json();
                App.state.pedidos = data;
                this.renderKanban();
            } catch(e) {}
        },
        renderKanban: function() {
            const estados = ['PENDIENTE', 'POR_PAGAR', 'PREPARACION', 'EN_DELIVERY', 'ENTREGADO'];
            const counts = { PENDIENTE: 0, POR_PAGAR: 0, PREPARACION: 0, EN_DELIVERY: 0, ENTREGADO: 0 };

            estados.forEach(est => {
                const col = document.getElementById(`col-${est}`);
                if(col) col.innerHTML = '';
            });

            App.state.pedidos.forEach(p => {
                const est = p.estado || 'PENDIENTE';
                if(counts[est] !== undefined) counts[est]++;

                const col = document.getElementById(`col-${est}`);
                if(col) {
                    col.innerHTML += this.renderCardHTML(p);
                }
            });

            // Actualizar contadores
            if(document.getElementById('count-pendiente')) document.getElementById('count-pendiente').innerText = counts.PENDIENTE;
            if(document.getElementById('count-por-pagar')) document.getElementById('count-por-pagar').innerText = counts.POR_PAGAR;
            if(document.getElementById('count-preparacion')) document.getElementById('count-preparacion').innerText = counts.PREPARACION;
            if(document.getElementById('count-en-delivery')) document.getElementById('count-en-delivery').innerText = counts.EN_DELIVERY;
            if(document.getElementById('count-entregado')) document.getElementById('count-entregado').innerText = counts.ENTREGADO;

            const badgePend = document.getElementById('badge-pedidos-pendientes');
            if(badgePend) {
                const totalPend = counts.PENDIENTE + counts.POR_PAGAR;
                badgePend.innerText = totalPend;
                badgePend.style.display = totalPend > 0 ? 'inline-block' : 'none';
            }
        },
        renderCardHTML: function(p) {
            let canalBadgeClass = 'badge-whatsapp';
            let canalIcon = 'ph-whatsapp-logo';
            if(p.canal === 'Instagram') { canalBadgeClass = 'badge-instagram'; canalIcon = 'ph-instagram-logo'; }
            else if(p.canal === 'Web') { canalBadgeClass = 'badge-web'; canalIcon = 'ph-globe'; }

            let itemsList = '';
            try {
                const its = Array.isArray(p.items_json) ? p.items_json : JSON.parse(p.items);
                itemsList = its.map(i => `${i.cantidad}x ${escapeHTML(i.nombre)}`).join(', ');
            } catch(e) { itemsList = 'Productos varios'; }

            let deliveryBadge = p.tipo_entrega === 'DELIVERY' 
                ? `<span class="badge-delivery-tag"><i class="ph-bold ph-moped"></i> Delivery (+$${(p.costo_envio || 0).toFixed(2)})</span>`
                : `<span class="badge-delivery-tag" style="color:var(--text-muted);"><i class="ph-bold ph-storefront"></i> Retiro</span>`;

            let comprobanteBtn = '';
            if(p.comprobante_url) {
                comprobanteBtn = `<button onclick="App.ui.zoomImage('${BASE_URL + p.comprobante_url}')" style="background:rgba(59,130,246,0.15); color:var(--info); border:none; padding:4px 8px; border-radius:6px; font-size:11px; cursor:pointer;" title="Ver Comprobante"><i class="ph-bold ph-image"></i> Ver Pago</button>`;
            }

            let nextActions = '';
            if(p.estado === 'PENDIENTE') {
                nextActions = `<button onclick="App.pedidos.cambiarEstado(${p.id}, 'POR_PAGAR')" class="btn-outline-blue" style="padding:4px 8px; font-size:11px; flex:1;">Esperar Pago</button>
                               <button onclick="App.pedidos.cambiarEstado(${p.id}, 'PREPARACION')" class="btn-primary-solid" style="padding:4px 8px; font-size:11px; flex:1;">Preparar</button>`;
            } else if(p.estado === 'POR_PAGAR') {
                nextActions = `<button onclick="App.pedidos.cambiarEstado(${p.id}, 'PREPARACION')" class="btn-primary-solid" style="padding:4px 8px; font-size:11px; width:100%; background:var(--success);"><i class="ph-bold ph-check-circle"></i> Validar Pago</button>`;
            } else if(p.estado === 'PREPARACION') {
                nextActions = `<button onclick="App.pedidos.cambiarEstado(${p.id}, 'EN_DELIVERY')" class="btn-primary-solid" style="padding:4px 8px; font-size:11px; flex:1; background:var(--info);"><i class="ph-bold ph-moped"></i> Despachar</button>
                               <button onclick="App.pedidos.facturarDirecto(${p.id})" class="btn-primary-solid" style="padding:4px 8px; font-size:11px; flex:1;"><i class="ph-bold ph-receipt"></i> Facturar</button>`;
            } else if(p.estado === 'EN_DELIVERY') {
                nextActions = `<button onclick="App.pedidos.facturarDirecto(${p.id})" class="btn-primary-solid" style="padding:4px 8px; font-size:11px; width:100%; background:var(--success);"><i class="ph-bold ph-check-circle"></i> Entregado & Facturar</button>`;
            } else {
                nextActions = `<span style="font-size:11px; color:var(--success); font-weight:bold;"><i class="ph-bold ph-check"></i> Orden Completada</span>`;
            }

            return `
                <div class="kanban-card">
                    <div class="kanban-card-top">
                        <span class="badge-canal ${canalBadgeClass}"><i class="ph-bold ${canalIcon}"></i> ${escapeHTML(p.canal)}</span>
                        <strong style="font-size:14px; color:var(--primary);">$${p.total.toFixed(2)}</strong>
                    </div>
                    <div style="font-size:13px; font-weight:700; color:var(--text-dark); margin-bottom:4px;">${escapeHTML(p.cliente_nombre)}</div>
                    <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">Folio: ${escapeHTML(p.folio)}</div>
                    <div style="font-size:11px; color:var(--text-dark); margin-bottom:8px; line-height:1.3;">📦 ${escapeHTML(itemsList)}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        ${deliveryBadge}
                        ${comprobanteBtn}
                    </div>
                    <div style="display:flex; gap:6px; margin-bottom:8px;">
                        ${nextActions}
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-color); padding-top:6px;">
                        <a href="https://wa.me/${(p.cliente_telefono || '').replace(/\D/g,'')}?text=${encodeURIComponent(`Hola *${p.cliente_nombre}*, sobre tu pedido *${p.folio}* en *${App.state.config.nombre_sistema || 'JCLIP'}*:`)}" target="_blank" style="font-size:11px; color:var(--success); text-decoration:none; font-weight:bold; display:flex; align-items:center; gap:4px;">
                            <i class="ph-bold ph-whatsapp-logo"></i> Escribir WA
                        </a>
                        <span style="font-size:10px; color:var(--text-muted);">${(p.fecha || '').substring(11, 16)}</span>
                    </div>
                </div>
            `;
        },
        abrirFormNuevo: function() {
            App.state.pedidoFormItems = [];
            const sel = document.getElementById('ped-prod-select');
            if(sel) {
                sel.innerHTML = App.state.productos.map(p => `<option value="${p.id}">${escapeHTML(p.nombre)} ($${p.precio})</option>`).join('');
            }
            this.renderFormItems();
            document.getElementById('modal-pedido-form').style.display = 'flex';
        },
        addItemALista: function() {
            const sel = document.getElementById('ped-prod-select');
            const qtyInput = document.getElementById('ped-prod-qty');
            if(!sel || !qtyInput) return;
            const prodId = parseInt(sel.value);
            const qty = parseFloat(qtyInput.value) || 1;
            const p = App.state.productos.find(x => x.id === prodId);
            if(!p) return;

            const exist = App.state.pedidoFormItems.find(x => x.id === prodId);
            if(exist) exist.cantidad += qty;
            else App.state.pedidoFormItems.push({ id: p.id, nombre: p.nombre, precio: p.precio, cantidad: qty });

            this.renderFormItems();
        },
        renderFormItems: function() {
            const container = document.getElementById('ped-items-lista-ui');
            if(!container) return;
            if(App.state.pedidoFormItems.length === 0) {
                container.innerHTML = '<span style="color:var(--text-muted);">Sin productos en el pedido aún.</span>';
            } else {
                container.innerHTML = App.state.pedidoFormItems.map((item, idx) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid var(--border-color);">
                        <span>${item.cantidad}x ${escapeHTML(item.nombre)}</span>
                        <span>$${(item.cantidad * item.precio).toFixed(2)}</span>
                        <button type="button" onclick="App.state.pedidoFormItems.splice(${idx},1); App.pedidos.renderFormItems();" style="background:transparent; border:none; color:var(--danger); cursor:pointer;"><i class="ph-bold ph-trash"></i></button>
                    </div>
                `).join('');
            }
            this.recalcTotal();
        },
        recalcTotal: function() {
            let sum = 0;
            App.state.pedidoFormItems.forEach(i => sum += (i.cantidad * i.precio));
            const envio = parseFloat(document.getElementById('ped-costo-envio').value) || 0.0;
            const tot = round2(sum + envio);
            const ui = document.getElementById('ped-total-ui');
            if(ui) ui.innerText = `$${tot.toFixed(2)}`;
        },
        guardarForm: async function(e) {
            e.preventDefault();
            if(App.state.pedidoFormItems.length === 0) return App.ui.toast("Agrega al menos un producto al pedido", "error");

            let sum = 0;
            App.state.pedidoFormItems.forEach(i => sum += (i.cantidad * i.precio));
            const envio = parseFloat(document.getElementById('ped-costo-envio').value) || 0.0;

            let compUrl = '';
            const file = document.getElementById('ped-comprobante-file').files[0];
            if(file) {
                const fd = new FormData();
                fd.append('file', file);
                try {
                    const upRes = await fetchAPI('/pedidos/upload_comprobante', { method: "POST", body: fd });
                    const upData = await upRes.json();
                    compUrl = upData.url;
                } catch(e) {}
            }

            const req = {
                cliente_cedula: document.getElementById('ped-cli-cedula').value || '0',
                cliente_nombre: document.getElementById('ped-cli-nombre').value,
                cliente_telefono: document.getElementById('ped-cli-telefono').value,
                canal: document.getElementById('ped-canal').value,
                items: JSON.stringify(App.state.pedidoFormItems),
                subtotal: round2(sum),
                costo_envio: envio,
                total: round2(sum + envio),
                metodo_pago: document.getElementById('ped-metodo-pago').value,
                ref_pago: document.getElementById('ped-ref-pago').value,
                comprobante_url: compUrl,
                tipo_entrega: document.getElementById('ped-tipo-entrega').value,
                motorizado: document.getElementById('ped-motorizado').value,
                direccion_envio: document.getElementById('ped-direccion').value,
                notas: document.getElementById('ped-notas').value
            };

            try {
                await fetchAPI('/pedidos', { method: "POST", body: JSON.stringify(req) });
                App.ui.toast("Pedido guardado con éxito", "success");
                document.getElementById('modal-pedido-form').style.display = 'none';
                e.target.reset();
                await this.load();
            } catch(err) {}
        },
        cambiarEstado: async function(id, nuevoEstado) {
            try {
                await fetchAPI(`/pedidos/${id}/estado`, { method: "PUT", body: JSON.stringify({ estado: nuevoEstado }) });
                App.ui.toast(`Pedido actualizado a ${nuevoEstado}`, "success");
                await this.load();
            } catch(e) {}
        },
        facturarDirecto: async function(id) {
            if(!confirm("¿Facturar este pedido y descontar inventario oficial?")) return;
            try {
                const res = await fetchAPI(`/pedidos/${id}/facturar`, { method: "POST" });
                const d = await res.json();
                App.ui.toast(`¡Venta procesada con éxito! Folio: ${d.venta_folio}`, "success");
                await this.load();
                await App.inv.load();
                await App.stats.load();
            } catch(e) {}
        }
    },

    // ==========================================
    // MÓDULO DE IMPRESIÓN DE ETIQUETAS
    // ==========================================
    etiquetas: {
        abrir: function(id) {
            App.state.prodEtiqueta = App.state.productos.find(x => x.id === id);
            if(!App.state.prodEtiqueta || !App.state.prodEtiqueta.codigo) return App.ui.toast("El producto no tiene un código SKU asignado", "warning");
            document.getElementById('eti-prod-name').innerText = App.state.prodEtiqueta.nombre;
            document.getElementById('modal-etiquetas').style.display = 'flex';
        },
        imprimir: function(e) {
            if(e) e.preventDefault();
            if(!App.state.prodEtiqueta) return;
            const qty = parseInt(document.getElementById('eti-qty').value) || 1;
            const size = document.getElementById('eti-size').value;
            const p = App.state.prodEtiqueta;
            const precioBs = round2(p.precio * App.state.config.tasa).toFixed(2);
            const sysName = App.state.config.nombre_sistema || 'JCLIP';

            const printWindow = window.open('', '_blank');
            let htmlLabels = '';
            for(let i=0; i<qty; i++) {
                htmlLabels += `
                    <div class="label-item ${size}">
                        <div class="label-header">${escapeHTML(sysName)}</div>
                        <div class="label-name">${escapeHTML(p.nombre)}</div>
                        <div class="label-barcode-box">
                            <img src="https://bwipjs-api.metafloor.com/?bcid=code128&text=${encodeURIComponent(p.codigo)}&scale=2&height=10&includetext" class="barcode-img" alt="${escapeHTML(p.codigo)}">
                        </div>
                        <div class="label-price">$${p.precio.toFixed(2)} <span style="font-size:9px; font-weight:normal;">(Bs. ${precioBs})</span></div>
                    </div>
                `;
            }

            printWindow.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Etiquetas - ${escapeHTML(p.nombre)}</title>
                    <style>
                        body { margin: 0; padding: 10px; font-family: monospace; }
                        .label-grid { display: flex; flex-wrap: wrap; gap: 8px; }
                        .label-item { border: 1px dashed #bbb; padding: 6px; text-align: center; box-sizing: border-box; page-break-inside: avoid; display: flex; flex-direction: column; justify-content: space-between; background: #fff; }
                        .label-item.50x30 { width: 50mm; height: 30mm; }
                        .label-item.40x25 { width: 40mm; height: 25mm; }
                        .label-header { font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
                        .label-name { font-size: 9px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 2px 0; }
                        .label-barcode-box { display: flex; justify-content: center; align-items: center; }
                        .barcode-img { max-width: 95%; max-height: 12mm; }
                        .label-price { font-size: 11px; font-weight: 900; }
                        @media print {
                            body { padding: 0; }
                            .label-item { border: none; margin: 0; }
                        }
                    </style>
                </head>
                <body onload="window.print();">
                    <div class="label-grid">
                        ${htmlLabels}
                    </div>
                </body>
                </html>
            `);
            printWindow.document.close();
            document.getElementById('modal-etiquetas').style.display = 'none';
            App.ui.toast(`Generando ${qty} etiqueta(s)...`, "success");
        }
    },

    // ==========================================
    // MÓDULO DE BITÁCORA Y AUDITORÍA DE ACCIONES
    // ==========================================
    bitacora: {
        load: async function() {
            try {
                const res = await fetchAPI('/bitacora');
                const data = await res.json();
                App.state.bitacora = data;
                const container = document.getElementById('lista-bitacora-ui');
                if(!container) return;
                
                if(!data || data.length === 0) {
                    container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No hay acciones registradas en la bitácora aún.</div>';
                } else {
                    container.innerHTML = data.map(b => `
                        <div style="padding:12px; border-bottom:1px solid var(--border-color); font-size:12px;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                                <strong style="color:var(--primary); font-size:13px;">${escapeHTML(b.usuario)}</strong> 
                                <span style="color:var(--text-muted); font-size:11px;">${b.fecha}</span>
                            </div>
                            <div style="font-weight:700; color:var(--warning); margin-bottom:3px;">${escapeHTML(b.accion)}</div>
                            <div style="color:var(--text-dark); word-break:break-word;">${escapeHTML(b.detalles)}</div>
                        </div>
                    `).join('');
                }
                document.getElementById('modal-bitacora').style.display = 'flex';
            } catch(e) {}
        }
    },

    // ==========================================
    // MÓDULO DE INVENTARIO Y CATÁLOGO
    // ==========================================
    inv: {
        load: async function() {
            try { const res = await fetchAPI('/productos'); const data = await res.json(); App.state.productos = data; this.render(App.state.productos); this.checkAlertas(); } catch (e) {}
        },
        abrirModalNuevo: function() {
            document.getElementById('prod-id').value = '';
            document.getElementById('form-producto').reset();
            document.getElementById('preview-img-prod').style.display = 'none';
            document.getElementById('area-variantes').style.display = 'none';
            document.getElementById('area-precios-base').style.display = 'block';
            document.getElementById('lista-variantes-ui').innerHTML = '';
            document.getElementById('modal-producto-title').innerText = 'Nuevo Artículo / Combo';
            document.getElementById('check-es-combo').checked = false;
            App.state.comboEditComponentes = [];
            App.combos.toggleUI(false);
            document.getElementById('modal-producto').style.display = 'flex';
        },
        render: function(lista) {
            const generarTarjeta = (p, isPremium) => {
                let qtyInCart = 0;
                App.state.carrito.forEach(c => { if(c.id === p.id) qtyInCart += c.cantidad; });
                let stockRestante = p.stock - qtyInCart;

                let stockMin = p.stock_minimo !== undefined ? p.stock_minimo : 5.0;

                let stockBadge = ""; let cardStyle = ""; let overlay = "";
                if(stockRestante <= 0) { 
                    overlay = `<div class="out-of-stock-overlay"><span class="badge-agotado-center">AGOTADO</span></div>`; 
                    cardStyle = `opacity: 0.6;`; 
                } else if(stockRestante <= stockMin) { 
                    stockBadge = `<div class="stock-badge-img" style="background:var(--warning);"><i class="ph-fill ph-warning"></i> Quedan ${stockRestante}</div>`; 
                } else { 
                    stockBadge = `<div class="stock-badge-img" style="background:var(--success);">Stock: ${stockRestante}</div>`; 
                }
                
                let precioBs = round2(p.precio * App.state.config.tasa).toFixed(2);
                let imgUrl = p.imagen_url ? (p.imagen_url.startsWith('http') ? p.imagen_url : BASE_URL + (p.imagen_url.startsWith('/') ? p.imagen_url : '/' + p.imagen_url)) : 'https://placehold.co/300x200/F1F5F9/cbd5e1?text=IMG';

                let extraControls = '';
                if(p.es_combo) {
                    extraControls = `<div style="font-size:11px; color:var(--info); font-weight:bold; margin-top:5px;"><i class="ph-bold ph-package"></i> Combo / Kit Promocional</div>`;
                } else if(p.variantes) {
                    let vars = []; try { vars = typeof p.variantes === 'string' ? JSON.parse(p.variantes) : p.variantes; } catch(e){}
                    if(vars.length > 0) {
                        extraControls = `<select id="var-${p.id}" class="product-variant-select" onclick="event.stopPropagation();">${vars.map((v, idx) => `<option value="${idx}">${escapeHTML(v.nombre)} - $${v.precio}</option>`).join('')}</select>`;
                    }
                } else if(p.es_peso) { 
                    extraControls = `<div style="font-size:11px; color:var(--primary); font-weight:bold; margin-top:5px;"><i class="ph-bold ph-scales"></i> Venta por Peso</div>`; 
                }

                let adminActions = '';
                if(App.state.usuario && ['admin', 'supervisor', 'superadmin'].includes(App.state.usuario.rol)) {
                    adminActions = `<div class="admin-only" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid var(--border-color); padding-top:10px; gap:6px;">
                        <button onclick="event.stopPropagation(); App.kardex.load(${p.id})" style="background:rgba(16,185,129,0.15); color:var(--success); border:none; padding:6px 8px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:11px; flex:1;" title="Ver Kardex"><i class="ph-bold ph-clock-counter-clockwise"></i></button>
                        <button onclick="event.stopPropagation(); App.etiquetas.abrir(${p.id})" style="background:var(--warning-bg); color:var(--warning); border:none; padding:6px 8px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:11px; flex:1;" title="Imprimir Etiqueta SKU"><i class="ph-bold ph-barcode"></i></button>
                        <button onclick="event.stopPropagation(); App.inv.editar(${p.id})" style="background:var(--info-bg); color:var(--info); border:none; padding:6px 8px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:11px; flex:1;" title="Editar"><i class="ph-bold ph-pencil"></i></button>
                        <button onclick="event.stopPropagation(); App.inv.eliminar(${p.id})" style="background:var(--danger-bg); color:var(--danger); border:none; padding:6px 8px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:11px; flex:1;" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
                    </div>`;
                }

                let cardClass = isPremium ? 'product-card product-card-premium' : 'product-card';
                let premiumBadge = isPremium ? `<div class="premium-badge">🔥 DESTACADO</div>` : '';

                return `<div class="${cardClass}" style="${cardStyle}" onclick="if(App.state.usuario && App.state.usuario.rol !== 'user' && ${stockRestante} > 0) App.pos.add(${p.id})">
                            ${premiumBadge}
                            <h3 class="product-title" style="margin-top:0; margin-bottom:12px; text-align:center; font-size:16px;">${escapeHTML(p.nombre)}</h3>
                            
                            <div class="product-img-box" onclick="event.stopPropagation(); App.ui.zoomImage('${imgUrl}')">${overlay} ${stockBadge}<img src="${imgUrl}" class="product-img" onerror="this.onerror=null; this.src='https://placehold.co/300x200/F1F5F9/cbd5e1?text=NO+IMG';"></div>
                            
                            <div style="text-align:center; margin-bottom: 8px;">
                                <span style="font-weight:900; color:var(--primary); font-size:12px; background: rgba(128,128,128,0.1); padding: 4px 8px; border-radius: 6px;">SKU: ${escapeHTML(p.codigo)}</span>
                            </div>

                            <div>
                                <p class="product-category" style="text-align:center;">${escapeHTML(p.categoria) || 'General'}</p>
                                <p class="product-desc">${escapeHTML(p.descripcion) || ''}</p>
                                <h4 class="product-price" style="text-align:center;">$${p.precio.toFixed(2)} <span class="product-price-bs">Bs. ${precioBs}</span></h4>
                                ${extraControls}
                            </div>
                            ${adminActions}
                        </div>`;
            };

            const grid = document.getElementById('lista-productos'); 
            const carrusel = document.getElementById('carrusel-productos');
            const carruselWrapper = document.getElementById('carrusel-wrapper');

            if(grid) grid.innerHTML = lista.map(p => generarTarjeta(p, false)).join('');
            
            if(carrusel && carruselWrapper) {
                const destacados = lista.filter(p => p.destacado === 1);
                if(destacados.length > 0) {
                    carruselWrapper.style.display = 'block';
                    carrusel.innerHTML = destacados.map(p => generarTarjeta(p, true)).join('');
                } else {
                    carruselWrapper.style.display = 'none';
                }
            }
        },
        filtrar: function(termino) {
            const f = termino.toLowerCase();
            this.render(App.state.productos.filter(p => p.nombre.toLowerCase().includes(f) || p.codigo.toLowerCase().includes(f) || (p.categoria && p.categoria.toLowerCase().includes(f))));
        },
        calcPrecio: function() {
            const costo = parseFloat(document.getElementById('costo').value) || 0; const ganancia = parseFloat(document.getElementById('ganancia').value) || 0;
            document.getElementById('precio').value = round2(costo * (1 + (ganancia / 100))).toFixed(2);
        },
        agregarVariante: function() {
            const list = document.getElementById('lista-variantes-ui'); const div = document.createElement('div'); div.className = "fila-variante"; div.style = "display:flex; gap:5px; margin-bottom:5px;";
            div.innerHTML = `<input type="text" placeholder="Nombre (Talla M)" class="input-glass" style="flex:2; margin:0;"><input type="number" placeholder="Cant" class="input-glass" style="flex:1; margin:0;"><input type="number" placeholder="$" class="input-glass" style="flex:1; margin:0;"><button type="button" style="background:transparent; color:var(--danger); border:none; cursor:pointer;" onclick="this.parentElement.remove()"><i class="ph-bold ph-trash"></i></button>`;
            list.appendChild(div);
        },
        editar: function(id) {
            if(!['admin', 'supervisor', 'superadmin'].includes(App.state.usuario.rol)) return;
            const p = App.state.productos.find(x => x.id === id); if(!p) return;
            
            document.getElementById('prod-id').value = p.id; 
            document.getElementById('codigo').value = p.codigo || ''; 
            document.getElementById('nombre').value = p.nombre || ''; 
            document.getElementById('descripcion').value = p.descripcion || ''; 
            document.getElementById('categoria-select').value = p.categoria || 'General'; 
            document.getElementById('costo').value = p.costo || 0; 
            document.getElementById('precio').value = p.precio || 0; 
            document.getElementById('stock').value = p.stock || 0; 
            document.getElementById('stock_minimo').value = p.stock_minimo !== undefined ? p.stock_minimo : 5;
            document.getElementById('es-peso').checked = p.es_peso === 1; 
            document.getElementById('vencimiento').value = p.vencimiento || '';
            document.getElementById('destacado').checked = p.destacado === 1;
            
            // Combos
            const checkCombo = document.getElementById('check-es-combo');
            if(checkCombo) {
                checkCombo.checked = p.es_combo === 1;
                App.combos.toggleUI(p.es_combo === 1);
                try {
                    App.state.comboEditComponentes = p.combo_items ? JSON.parse(p.combo_items) : [];
                } catch(e) { App.state.comboEditComponentes = []; }
                App.combos.renderComponentes();
            }

            let provsArray = []; try { provsArray = JSON.parse(p.proveedor); } catch(e){ provsArray = [p.proveedor]; }
            document.querySelectorAll('.prov-checkbox').forEach(cb => { cb.checked = provsArray.includes(cb.value); });
            
            if(p.costo && p.costo > 0) document.getElementById('ganancia').value = round2(((p.precio - p.costo) / p.costo) * 100).toFixed(1); else document.getElementById('ganancia').value = 0;

            const listVars = document.getElementById('lista-variantes-ui'); listVars.innerHTML = "";
            if(p.variantes) {
                document.getElementById('check-variantes').checked = true; document.getElementById('area-variantes').style.display = 'block'; document.getElementById('area-precios-base').style.display = 'none';
                let vars = typeof p.variantes === 'string' ? JSON.parse(p.variantes) : p.variantes;
                vars.forEach(v => {
                    const div = document.createElement('div'); div.className = "fila-variante"; div.style = "display:flex; gap:5px; margin-bottom:5px;";
                    div.innerHTML = `<input type="text" value="${escapeHTML(v.nombre)}" class="input-glass" style="flex:2; margin:0;"><input type="number" value="${v.stock}" class="input-glass" style="flex:1; margin:0;"><input type="number" value="${v.precio}" class="input-glass" style="flex:1; margin:0;"><button type="button" style="background:transparent; color:var(--danger); border:none; cursor:pointer;" onclick="this.parentElement.remove()"><i class="ph-bold ph-trash"></i></button>`;
                    listVars.appendChild(div);
                });
            } else { document.getElementById('check-variantes').checked = false; document.getElementById('area-variantes').style.display = 'none'; document.getElementById('area-precios-base').style.display = 'block'; }
            
            document.getElementById('modal-producto-title').innerText = 'Editar Artículo / Combo';
            document.getElementById('modal-producto').style.display = 'flex';
        },
        eliminar: async function(id) {
            if(!confirm("¿Estás seguro de que deseas eliminar este producto permanentemente?")) return;
            try { await fetchAPI(`/productos/${id}`, { method: 'DELETE' }); App.ui.toast("Producto Eliminado", "success"); this.load(); } catch(e) {}
        },
        guardarForm: async function(e) {
            e.preventDefault(); const id = document.getElementById('prod-id').value; const formData = new FormData();
            let selectedProvs = []; document.querySelectorAll('.prov-checkbox:checked').forEach(cb => selectedProvs.push(cb.value));

            formData.append("codigo", document.getElementById('codigo').value); 
            formData.append("nombre", document.getElementById('nombre').value); 
            formData.append("descripcion", document.getElementById('descripcion').value); 
            formData.append("categoria", document.getElementById('categoria-select').value); 
            formData.append("proveedor", JSON.stringify(selectedProvs)); 
            formData.append("costo", document.getElementById('costo').value || 0); 
            formData.append("precio", document.getElementById('precio').value || 0); 
            formData.append("stock", document.getElementById('stock').value || 0); 
            formData.append("stock_minimo", document.getElementById('stock_minimo').value || 5);
            formData.append("es_peso", document.getElementById('es-peso').checked ? 1 : 0); 
            formData.append("vencimiento", document.getElementById('vencimiento').value);
            formData.append("destacado", document.getElementById('destacado').checked ? 1 : 0);

            const isCombo = document.getElementById('check-es-combo') ? document.getElementById('check-es-combo').checked : false;
            formData.append("es_combo", isCombo ? 1 : 0);
            formData.append("combo_items", isCombo ? JSON.stringify(App.state.comboEditComponentes) : "");

            const file = document.getElementById('input-file-prod').files[0]; if(file) formData.append("imagen", file);

            if(document.getElementById('check-variantes').checked) {
                const vars = []; document.querySelectorAll('.fila-variante').forEach(f => { vars.push({ nombre: f.children[0].value, stock: parseFloat(f.children[1].value), precio: parseFloat(f.children[2].value) }); });
                formData.append("variantes", JSON.stringify(vars));
            } else { formData.append("variantes", ""); }
            
            if(file) App.ui.toast("Procesando foto con IA en la nube. Espera...", "info");

            try {
                await fetchAPI(id ? `/productos/${id}` : `/productos`, { method: id ? "PUT" : "POST", body: formData });
                App.ui.toast(id ? "Producto Actualizado" : "Producto Creado", "success"); 
                document.getElementById('modal-producto').style.display = 'none'; 
                e.target.reset(); 
                document.getElementById('prod-id').value = ''; 
                this.load();
            } catch(err) {}
        },
        checkAlertas: function() {
            const lista = document.getElementById('lista-caducidad'); if(!lista) return;
            let html = ""; const hoy = new Date();
            App.state.productos.forEach(p => {
                const stMin = p.stock_minimo !== undefined ? p.stock_minimo : 5.0;
                if(p.stock <= stMin) html += `<div style="padding:10px; border-bottom:1px solid var(--border-color); color:var(--warning);">⚠️ ${escapeHTML(p.nombre)} - Bajo Stock (${p.stock} / Mín: ${stMin})</div>`;
                if(p.vencimiento) {
                    const diffDias = Math.ceil((new Date(p.vencimiento) - hoy) / (1000 * 60 * 60 * 24));
                    if(diffDias <= 30 && diffDias > 0) html += `<div style="padding:10px; border-bottom:1px solid var(--border-color); color:var(--warning);">📅 ${escapeHTML(p.nombre)} - Vence en ${diffDias} días.</div>`;
                    else if(diffDias <= 0) html += `<div style="padding:10px; border-bottom:1px solid var(--border-color); color:var(--danger); font-weight:bold;">🚨 ${escapeHTML(p.nombre)} - VENCIDO.</div>`;
                }
            });
            if(html !== "") { lista.innerHTML = html; lista.classList.remove('empty-state'); } else { lista.innerHTML = "Todo en orden"; lista.classList.add('empty-state'); }
        }
    },

    // ==========================================
    // MÓDULO CRM & EXPEDIENTE 360
    // ==========================================
    crm: {
        load: async function() { try { const res = await fetchAPI('/clientes'); const data = await res.json(); App.state.clientes = data; this.render(); } catch (e) {} },
        render: function() {
            const c = document.getElementById('lista-clientes-ui'); if(!c) return;
            c.innerHTML = App.state.clientes.map(cli => {
                let avatar = cli.foto ? (cli.foto.startsWith('http') ? cli.foto : BASE_URL + cli.foto) : `https://ui-avatars.com/api/?name=${cli.nombre}&background=8064F9&color=fff`;
                return `<div style="padding:10px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img src="${avatar}" style="width:34px; height:34px; border-radius:50%; object-fit:cover;">
                        <div>
                            <strong style="display:block; font-size:13px;">${escapeHTML(cli.nombre)}</strong>
                            <span style="font-size:11px; color:var(--text-muted);">${escapeHTML(cli.cedula)} | Pts: ${(cli.puntos || 0).toFixed(2)} ${cli.instagram ? '| @' + escapeHTML(cli.instagram) : ''}</span>
                        </div>
                    </div>
                    <div class="admin-only" style="display:flex; gap:6px;">
                        <button onclick="App.crm.verHistorial('${cli.cedula}')" style="background:rgba(59,130,246,0.15); color:var(--info); border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:11px; font-weight:bold;" title="Expediente 360°"><i class="ph-bold ph-eye"></i> Historial</button>
                        <button onclick="App.crm.editar('${cli.cedula}')" style="background:var(--info-bg); color:var(--info); border:none; padding:6px; border-radius:6px; cursor:pointer;"><i class="ph-bold ph-pencil"></i></button>
                        <button onclick="App.crm.eliminar('${cli.cedula}')" style="background:var(--danger-bg); color:var(--danger); border:none; padding:6px; border-radius:6px; cursor:pointer;"><i class="ph-bold ph-trash"></i></button>
                    </div>
                </div>`;
            }).join(''); c.classList.remove('empty-state');
        },
        verHistorial: async function(cedula) {
            try {
                const res = await fetchAPI(`/clientes/${cedula}/historial`);
                const data = await res.json();
                const cli = data.cliente;
                const totalComp = data.total_comprado_usd || 0.0;
                
                // Scoring de cliente
                let scoringBadge = `<span class="badge-scoring badge-scoring-nuevo">🆕 Cliente Nuevo</span>`;
                if(data.creditos.some(cr => cr.estado === 'PENDIENTE')) {
                    scoringBadge = `<span class="badge-scoring badge-scoring-moroso">⚠️ Fiados Pendientes</span>`;
                } else if(totalComp > 500) {
                    scoringBadge = `<span class="badge-scoring badge-scoring-vip">🏆 Cliente VIP</span>`;
                } else if(totalComp > 150 || data.total_compras >= 5) {
                    scoringBadge = `<span class="badge-scoring badge-scoring-frecuente">⭐ Cliente Frecuente</span>`;
                } else if(data.total_compras >= 1) {
                    scoringBadge = `<span class="badge-scoring badge-scoring-regular">🟢 Regular</span>`;
                }

                let ventasHTML = data.ventas.length === 0 ? '<p style="color:var(--text-muted); font-size:12px;">Sin compras registradas aún.</p>' : data.ventas.map(v => `
                    <div style="padding:8px 0; border-bottom:1px solid var(--border-color); font-size:12px;">
                        <div style="display:flex; justify-content:space-between;">
                            <strong>${v.folio}</strong>
                            <strong style="color:var(--primary);">$${v.total_usd.toFixed(2)}</strong>
                        </div>
                        <div style="color:var(--text-muted); font-size:11px;">${v.fecha} - ${v.tipo_entrega || 'MOSTRADOR'}</div>
                        <div style="font-size:11px; margin-top:2px;">${v.items ? v.items.map(i => `${i.cantidad}x ${escapeHTML(i.nombre)}`).join(', ') : ''}</div>
                    </div>
                `).join('');

                const container = document.getElementById('cliente-historial-content');
                container.innerHTML = `
                    <div style="display:flex; gap:15px; align-items:center; margin-bottom:15px; background:rgba(128,128,128,0.06); padding:15px; border-radius:12px; border:1px solid var(--border-color);">
                        <img src="${cli.foto ? (cli.foto.startsWith('http') ? cli.foto : BASE_URL + cli.foto) : 'https://ui-avatars.com/api/?name=' + cli.nombre}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">
                        <div>
                            <h3 style="margin:0; font-size:16px;">${escapeHTML(cli.nombre)}</h3>
                            <div style="font-size:12px; color:var(--text-muted);">${cli.cedula} | ${cli.telefono}</div>
                            <div style="margin-top:4px;">${scoringBadge}</div>
                        </div>
                    </div>

                    ${cli.instagram ? `<div style="font-size:12px; margin-bottom:8px;">📸 <strong>Instagram:</strong> @${escapeHTML(cli.instagram)}</div>` : ''}
                    ${cli.direccion ? `<div style="font-size:12px; margin-bottom:8px;">📍 <strong>Dirección:</strong> ${escapeHTML(cli.direccion)}</div>` : ''}
                    ${cli.referencia_direccion ? `<div style="font-size:12px; margin-bottom:8px;">🛵 <strong>Punto de Entrega:</strong> ${escapeHTML(cli.referencia_direccion)}</div>` : ''}
                    ${cli.notas ? `<div style="font-size:12px; margin-bottom:12px; background:rgba(245,158,11,0.1); padding:8px; border-radius:6px; color:var(--warning);">📝 <strong>Preferencias / Notas:</strong> ${escapeHTML(cli.notas)}</div>` : ''}

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                        <div style="background:var(--card-bg); padding:10px; border-radius:8px; border:1px solid var(--border-color); text-align:center;">
                            <span style="font-size:11px; color:var(--text-muted);">Total Gastado</span>
                            <div style="font-size:18px; font-weight:800; color:var(--success);">$${totalComp.toFixed(2)}</div>
                        </div>
                        <div style="background:var(--card-bg); padding:10px; border-radius:8px; border:1px solid var(--border-color); text-align:center;">
                            <span style="font-size:11px; color:var(--text-muted);">Puntos Acumulados</span>
                            <div style="font-size:18px; font-weight:800; color:var(--primary);">${(cli.puntos || 0).toFixed(2)}</div>
                        </div>
                    </div>

                    <h4 style="margin:0 0 8px 0; font-size:13px; color:var(--text-dark);">Historial de Compras (${data.total_compras})</h4>
                    <div style="max-height:180px; overflow-y:auto; margin-bottom:15px;">
                        ${ventasHTML}
                    </div>
                `;
                document.getElementById('modal-cliente-historial').style.display = 'flex';
            } catch(e) {}
        },
        editar: function(cedula) {
            const cli = App.state.clientes.find(x => x.cedula === cedula); if(!cli) return;
            document.getElementById('cli-nombre').value = cli.nombre || ''; 
            document.getElementById('cli-cedula').value = cli.cedula.substring(2) || ''; 
            document.getElementById('cli-telefono').value = cli.telefono || ''; 
            document.getElementById('cli-instagram').value = cli.instagram || '';
            document.getElementById('cli-direccion').value = cli.direccion || ''; 
            document.getElementById('cli-referencia').value = cli.referencia_direccion || '';
            document.getElementById('cli-notas').value = cli.notas || '';
            
            let preview = document.getElementById('cli-preview-img');
            if(cli.foto) { preview.src = cli.foto.startsWith('http') ? cli.foto : BASE_URL + cli.foto; preview.style.display = 'block'; } else { preview.style.display = 'none'; }
            document.getElementById('modal-clientes').style.display = 'flex';
        },
        eliminar: async function(cedula) {
            if(!confirm("¿Seguro que deseas eliminar este cliente?")) return;
            try { await fetchAPI(`/clientes/${cedula}`, { method: 'DELETE' }); App.ui.toast("Cliente Eliminado", "success"); this.load(); } catch(e) {}
        },
        guardarForm: async function(e) {
            e.preventDefault(); const formData = new FormData(); const cedulaFinal = document.getElementById('cli-tipo').value + document.getElementById('cli-cedula').value;
            formData.append("nombre", document.getElementById('cli-nombre').value); 
            formData.append("cedula", cedulaFinal); 
            formData.append("telefono", document.getElementById('cli-telefono').value); 
            formData.append("instagram", document.getElementById('cli-instagram').value || '');
            formData.append("direccion", document.getElementById('cli-direccion').value || ''); 
            formData.append("referencia_direccion", document.getElementById('cli-referencia').value || '');
            formData.append("notas", document.getElementById('cli-notas').value || '');
            
            const file = document.getElementById('cli-file').files[0]; if(file) formData.append("foto", file);
            try {
                await fetchAPI('/clientes', { method: "POST", body: formData }); 
                App.ui.toast("Cliente Registrado", "success"); 
                document.getElementById('modal-clientes').style.display = 'none'; 
                document.getElementById('modal-clientes').style.zIndex = "4000"; 
                e.target.reset(); 
                this.load();
                if(document.getElementById('modal-caja-flotante').style.display === 'flex') { 
                    App.state.clienteActual = { cedula: cedulaFinal, nombre: formData.get('nombre'), puntos: 0 }; 
                    document.getElementById('input-cliente-cedula').value = cedulaFinal; 
                    document.getElementById('input-cliente-nombre').value = formData.get('nombre'); 
                    App.pos.calcTotal(); 
                }
            } catch(err) {}
        },
        buscarYAsignar: function() {
            const rawInput = document.getElementById('input-cliente-cedula').value; const nombre = document.getElementById('input-cliente-nombre').value;
            if(!rawInput && !nombre) return App.ui.toast("Ingrese cédula o nombre", "warning");
            const type = document.getElementById('input-cliente-tipo').value; const cedulaBusqueda = rawInput.includes('-') ? rawInput : type + rawInput;
            const cli = App.state.clientes.find(c => c.cedula.includes(cedulaBusqueda) || (nombre && c.nombre.toLowerCase().includes(nombre.toLowerCase())));
            if(cli) {
                App.state.clienteActual = cli; 
                document.getElementById('input-cliente-cedula').value = cli.cedula; 
                document.getElementById('input-cliente-nombre').value = cli.nombre;
                
                const panelPts = document.getElementById('alerta-puntos');
                if(cli.puntos && cli.puntos > 0) { 
                    panelPts.style.display = 'flex'; 
                    document.getElementById('txt-puntos').innerText = `Tiene ${(cli.puntos || 0).toFixed(2)} Puntos Disponibles`; 
                } else { panelPts.style.display = 'none'; }
                
                const badgeScoring = document.getElementById('cliente-scoring-badge');
                if(badgeScoring) {
                    badgeScoring.style.display = 'block';
                    badgeScoring.innerHTML = cli.notas ? `<small style="color:var(--warning);">📝 ${escapeHTML(cli.notas)}</small>` : '';
                }

                App.pos.calcTotal(); 
                App.ui.toast(`Cliente vinculado: ${cli.nombre}`, "success");
            } else { 
                if(confirm("El cliente no existe. ¿Deseas registrarlo ahora?")) {
                    document.getElementById('cli-cedula').value = rawInput.replace(/^[VJE]-/,'');
                    document.getElementById('cli-nombre').value = nombre;
                    document.getElementById('modal-clientes').style.zIndex = "4005";
                    document.getElementById('modal-clientes').style.display = 'flex';
                }
            }
        },
        canjear: function() {
            if(!App.state.clienteActual || !App.state.clienteActual.puntos) return;
            let maxCanje = Math.min(App.state.clienteActual.puntos, App.state.subtotal);
            let pts = parseFloat(prompt(`Ingresa los puntos a canjear (Máximo $${maxCanje.toFixed(2)}):`, maxCanje.toFixed(2)));
            if(isNaN(pts) || pts <= 0 || pts > maxCanje) return App.ui.toast("Puntos inválidos", "error");
            App.state.puntosACanjear = pts;
            document.getElementById('row-puntos').style.display = 'flex';
            document.getElementById('ta-puntos').innerText = `-$${pts.toFixed(2)}`;
            App.pos.calcTotal();
            App.ui.toast(`Canje de $${pts.toFixed(2)} aplicado`, "success");
        },
        prepararMarketing: function() {
            const msg = document.getElementById('mkt-mensaje').value; if(!msg) return App.ui.toast("Escribe un mensaje", "warning");
            const list = document.getElementById('lista-mkt-ui');
            list.innerHTML = App.state.clientes.filter(c => c.telefono && c.telefono.length > 5 && c.telefono !== '0000').map(c => `
                <div style="padding:10px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                    <div><strong>${escapeHTML(c.nombre)}</strong> (${escapeHTML(c.telefono)})</div>
                    <a href="https://wa.me/${c.telefono.replace(/\D/g,'')}?text=${encodeURIComponent(msg)}" target="_blank" class="btn-outline-blue" style="padding:4px 8px; font-size:11px; color:var(--success); border-color:var(--success);"><i class="ph-bold ph-whatsapp-logo"></i> Enviar</a>
                </div>
            `).join('');
        }
    },

    // ==========================================
    // MÓDULO POS / FACTURACIÓN PRO
    // ==========================================
    pos: {
        add: function(id) {
            const p = App.state.productos.find(x => x.id === id); if(!p) return;
            let itemToAdd = { id: p.id, nombre: p.nombre, precio: p.precio, cantidad: 1, variante_idx: null };

            if(p.variantes) {
                let vSelect = document.getElementById(`var-${p.id}`);
                let idx = vSelect ? parseInt(vSelect.value) : 0;
                let vars = typeof p.variantes === 'string' ? JSON.parse(p.variantes) : p.variantes;
                if(vars && vars[idx]) {
                    itemToAdd.nombre = `${p.nombre} (${vars[idx].nombre})`;
                    itemToAdd.precio = vars[idx].precio;
                    itemToAdd.variante_idx = idx;
                }
            } else if(p.es_peso) {
                let peso = parseFloat(prompt(`Ingresa el peso en Kg para '${p.nombre}':`, "1.00"));
                if(isNaN(peso) || peso <= 0) return App.ui.toast("Peso inválido", "error");
                itemToAdd.cantidad = peso;
            }

            const exist = App.state.carrito.find(c => c.id === itemToAdd.id && c.variante_idx === itemToAdd.variante_idx);
            if(exist) { 
                if(!p.es_peso) exist.cantidad += 1; 
                else exist.cantidad = round2(exist.cantidad + itemToAdd.cantidad); 
            } else { 
                App.state.carrito.push(itemToAdd); 
            }

            App.ui.toast(`Añadido: ${itemToAdd.nombre}`, "success");
            this.render();
            actualizarVista();
        },
        render: function() {
            const container = document.getElementById('invoice-items-admin'); if(!container) return;
            if(App.state.carrito.length === 0) {
                container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);"><i class="ph-bold ph-shopping-cart" style="font-size:30px; display:block; margin-bottom:5px;"></i>Carrito Vacío</div>';
            } else {
                container.innerHTML = App.state.carrito.map((item, idx) => `
                    <div style="padding:10px 0; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                        <div style="flex:1.5;">
                            <strong style="font-size:13px; color:var(--text-dark);">${escapeHTML(item.nombre)}</strong>
                            <div style="font-size:11px; color:var(--text-muted);">$${item.precio.toFixed(2)} c/u</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <button onclick="App.pos.changeQty(${idx}, -1)" style="width:28px; height:28px; border-radius:50%; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-dark); cursor:pointer; font-weight:bold;">-</button>
                            <span style="font-weight:bold; font-size:13px; min-width:20px; text-align:center;">${item.cantidad}</span>
                            <button onclick="App.pos.changeQty(${idx}, 1)" style="width:28px; height:28px; border-radius:50%; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-dark); cursor:pointer; font-weight:bold;">+</button>
                        </div>
                        <div style="flex:1; text-align:right; font-weight:800; color:var(--primary); font-size:14px;">
                            $${round2(item.precio * item.cantidad).toFixed(2)}
                        </div>
                        <button onclick="App.pos.removeItem(${idx})" style="background:transparent; border:none; color:var(--danger); cursor:pointer; margin-left:10px;"><i class="ph-bold ph-trash"></i></button>
                    </div>
                `).join('');
            }
            this.calcTotal();
        },
        changeQty: function(idx, delta) {
            if(!App.state.carrito[idx]) return;
            App.state.carrito[idx].cantidad = round2(App.state.carrito[idx].cantidad + delta);
            if(App.state.carrito[idx].cantidad <= 0) {
                App.state.carrito.splice(idx, 1);
            }
            this.render();
            actualizarVista();
        },
        removeItem: function(idx) {
            App.state.carrito.splice(idx, 1);
            this.render();
            actualizarVista();
        },
        toggleDeliveryFields: function() {
            const sel = document.getElementById('pos-tipo-entrega').value;
            const extra = document.getElementById('pos-delivery-extra');
            if(extra) extra.style.display = sel === 'DELIVERY' ? 'flex' : 'none';
            this.calcTotal();
        },
        calcCreditoPreview: function() {
            const total = parseFloat(document.getElementById('ta-final').innerText.replace('$','')) || 0;
            const porcInicial = parseFloat(document.getElementById('cred-porc-inicial').value) || 0;
            const numCuotas = parseInt(document.getElementById('cred-num-cuotas').value) || 1;
            const inicialMonto = round2(total * (porcInicial / 100));
            const saldo = round2(total - inicialMonto);
            const montoCuota = round2(saldo / numCuotas);

            document.getElementById('cred-prev-inicial').innerText = `$${inicialMonto.toFixed(2)}`;
            document.getElementById('cred-prev-saldo').innerText = `$${saldo.toFixed(2)}`;
            document.getElementById('cred-prev-cuotas-txt').innerText = `${numCuotas} cuota(s) de $${montoCuota.toFixed(2)}`;
        },
        calcTotal: function() {
            let sum = 0;
            App.state.carrito.forEach(c => sum += round2(c.precio * c.cantidad));
            App.state.subtotal = round2(sum);

            const inputDesc = document.getElementById('input-desc');
            App.state.descPorc = inputDesc ? (parseFloat(inputDesc.value) || 0) : 0;
            const inputIva = document.getElementById('input-iva');
            App.state.ivaPorc = inputIva ? (parseFloat(inputIva.value) || 0) : 16;

            const tipoEntrega = document.getElementById('pos-tipo-entrega') ? document.getElementById('pos-tipo-entrega').value : 'MOSTRADOR';
            const costoEnvio = (tipoEntrega === 'DELIVERY' && document.getElementById('pos-costo-envio')) ? (parseFloat(document.getElementById('pos-costo-envio').value) || 0.0) : 0.0;
            App.state.costoEnvio = costoEnvio;

            const descMonto = round2(App.state.subtotal * (App.state.descPorc / 100));
            const totalConIva = round2(App.state.subtotal - descMonto);
            const baseImp = round2(totalConIva / (1 + (App.state.ivaPorc / 100)));
            const ivaMonto = round2(totalConIva - baseImp);

            const totalFinal = Math.max(0, round2(totalConIva - App.state.puntosACanjear + costoEnvio));
            const totalBs = round2(totalFinal * App.state.config.tasa);

            if(document.getElementById('ta-subtotal-val')) document.getElementById('ta-subtotal-val').innerText = `$${App.state.subtotal.toFixed(2)}`;
            if(document.getElementById('ta-desc')) document.getElementById('ta-desc').innerText = `-$${descMonto.toFixed(2)}`;
            if(document.getElementById('ta-iva')) document.getElementById('ta-iva').innerText = `$${ivaMonto.toFixed(2)}`;
            
            const rowDelivery = document.getElementById('row-delivery');
            if(rowDelivery) {
                rowDelivery.style.display = costoEnvio > 0 ? 'flex' : 'none';
                document.getElementById('ta-delivery').innerText = `+$${costoEnvio.toFixed(2)}`;
            }

            if(document.getElementById('ta-final')) document.getElementById('ta-final').innerText = `$${totalFinal.toFixed(2)}`;
            if(document.getElementById('ta-bs')) document.getElementById('ta-bs').innerText = `Bs. ${totalBs.toFixed(2)}`;

            if(App.state.isMixto) this.calcMixtoRestante(totalFinal);
            this.calcCreditoPreview();

            // Sincronizar en tiempo real con Pantalla Secundaria del Cliente
            if(posChannel) {
                posChannel.postMessage({
                    action: 'update',
                    carrito: App.state.carrito,
                    subtotal: `$${App.state.subtotal.toFixed(2)}`,
                    iva: `$${ivaMonto.toFixed(2)}`,
                    total: `$${totalFinal.toFixed(2)}`,
                    totalBs: `Bs. ${totalBs.toFixed(2)}`
                });
            }
        },
        addMixtoRow: function() {
            const container = document.getElementById('mixto-rows-container'); if(!container) return;
            const div = document.createElement('div');
            div.className = "mixto-row";
            div.style = "display:flex; gap:8px; margin-bottom:8px;";
            div.innerHTML = `
                <select class="select-metodo-mixto input-glass" style="flex:1.5; margin:0;" onchange="App.pos.calcTotal()">
                    <option value="Efectivo ($)">Efectivo ($)</option>
                    <option value="Efectivo (Bs)">Efectivo (Bs)</option>
                    <option value="Pago Móvil (Bs)">Pago Móvil (Bs)</option>
                    <option value="Binance">Binance</option>
                    <option value="Punto de Venta (Bs)">Punto (Bs)</option>
                </select>
                <input type="number" step="0.01" placeholder="Monto" class="input-monto-mixto input-glass" style="flex:1; margin:0;" onkeyup="App.pos.calcTotal()">
                <button type="button" style="background:transparent; color:var(--danger); border:none; cursor:pointer;" onclick="this.parentElement.remove(); App.pos.calcTotal();"><i class="ph-bold ph-trash"></i></button>
            `;
            container.appendChild(div);
            this.calcTotal();
        },
        resetMixto: function() {
            const container = document.getElementById('mixto-rows-container');
            if(container) container.innerHTML = '';
            document.getElementById('area-mixto').style.display = 'none';
        },
        calcMixtoRestante: function(totalUSD) {
            let pagadoUSD = 0;
            document.querySelectorAll('.mixto-row').forEach(row => {
                const sel = row.querySelector('.select-metodo-mixto').value;
                const val = parseFloat(row.querySelector('.input-monto-mixto').value) || 0;
                let eq = sel.includes('(Bs)') ? round2(val / App.state.config.tasa) : round2(val);
                pagadoUSD = round2(pagadoUSD + eq);
            });
            const diff = round2(totalUSD - pagadoUSD);
            const info = document.getElementById('info-restante-mixto');
            if(info) {
                if(diff > 0.01) {
                    info.style.color = "var(--danger)";
                    info.innerText = `Faltan por cubrir: $${diff.toFixed(2)} (Bs. ${(diff * App.state.config.tasa).toFixed(2)})`;
                } else if(diff < -0.01) {
                    info.style.color = "var(--success)";
                    info.innerText = `Vuelto a entregar: $${Math.abs(diff).toFixed(2)} (Bs. ${(Math.abs(diff) * App.state.config.tasa).toFixed(2)})`;
                } else {
                    info.style.color = "var(--success)";
                    info.innerText = "¡Monto exacto cubierto!";
                }
            }
        },
        pausar: function() {
            if(App.state.carrito.length === 0) return App.ui.toast("Carrito vacío", "warning");
            App.state.pausadas.push({
                cliente: App.state.clienteActual ? App.state.clienteActual.nombre : "Cliente Mostrador",
                hora: new Date().toLocaleTimeString(),
                carrito: [...App.state.carrito]
            });
            this.limpiarCaja();
            App.ui.toast("Venta colocada en espera", "info");
        },
        mostrarPausadas: function() {
            const container = document.getElementById('lista-espera-ui'); if(!container) return;
            if(App.state.pausadas.length === 0) {
                container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No hay ventas en espera</div>';
            } else {
                container.innerHTML = App.state.pausadas.map((p, idx) => `
                    <div style="padding:12px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHTML(p.cliente)}</strong>
                            <div style="font-size:11px; color:var(--text-muted);">${p.hora} - ${p.carrito.length} artículos</div>
                        </div>
                        <button onclick="App.pos.recuperarPausada(${idx})" class="btn-primary-solid" style="padding:6px 12px; font-size:12px;">Recuperar</button>
                    </div>
                `).join('');
            }
            document.getElementById('modal-espera').style.display = 'flex';
        },
        recuperarPausada: function(idx) {
            if(App.state.pausadas[idx]) {
                App.state.carrito = [...App.state.pausadas[idx].carrito];
                App.state.pausadas.splice(idx, 1);
                document.getElementById('modal-espera').style.display = 'none';
                this.render();
                actualizarVista();
                App.ui.toast("Factura recuperada", "success");
            }
        },
        generarQR: function() {
            let total = document.getElementById('ta-bs').innerText; if(!total || total === 'Bs. 0.00') return App.ui.toast("Agrega productos primero", "warning");
            document.getElementById('qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`Pago Móvil JCLIP\nTel: ${App.state.config.telefono || 'Tienda'}\nMonto: ${total}`)}`;
            document.getElementById('modal-qr').style.display = 'flex';
        },
        cobrar: async function(esPausa = false) {
            if(App.state.carrito.length === 0) return App.ui.toast("Carrito vacío", "error");
            
            // Validación de Cliente
            if(!App.state.clienteActual || !App.state.clienteActual.cedula) {
                return App.ui.toast("⚠️ Debes vincular a un cliente o usar la Cédula 0 para Ventas Rápidas", "error");
            }

            const totalUSD = parseFloat(document.getElementById('ta-final').innerText.replace('$',''));
            const esCredito = document.getElementById('input-metodo-seleccionado').value === 'Crédito';
            if(esCredito && App.state.clienteActual.cedula === "0") return App.ui.toast("No puedes fiarle a 'Ventas Rápidas'", "error");

            let jsonMetodos = []; let refDigital = document.getElementById('ref_pago_digital') ? document.getElementById('ref_pago_digital').value : "";

            let inicialMonto = 0.0;
            let numCuotas = 1;
            let frecuencia = 'MENSUAL';

            if(esCredito) {
                const porcInicial = parseFloat(document.getElementById('cred-porc-inicial').value) || 0;
                inicialMonto = round2(totalUSD * (porcInicial / 100));
                numCuotas = parseInt(document.getElementById('cred-num-cuotas').value) || 1;
                frecuencia = document.getElementById('cred-frecuencia').value || 'MENSUAL';
                jsonMetodos.push({ metodo: 'Crédito', monto: round2(totalUSD - inicialMonto), ref: `INICIAL $${inicialMonto}` });
            } else if(!App.state.isMixto) {
                jsonMetodos.push({ metodo: document.getElementById('input-metodo-seleccionado').value, monto: totalUSD, ref: refDigital });
            } else {
                let pagadoUSD = 0;
                document.querySelectorAll('.mixto-row').forEach((row, idx) => {
                    const select = row.querySelector('.select-metodo-mixto').value; const inputVal = parseFloat(row.querySelector('.input-monto-mixto').value) || 0;
                    let montoEq = select.includes('(Bs)') ? round2(inputVal / App.state.config.tasa) : round2(inputVal);
                    pagadoUSD = round2(pagadoUSD + montoEq);
                    if(inputVal > 0) jsonMetodos.push({ metodo: select, monto: montoEq, ref: idx === 0 ? refDigital : "" });
                });
                if(pagadoUSD < round2(totalUSD - 0.05) && !esPausa) { return App.ui.toast("Monto incompleto", "error"); }
            }

            const tipoEntrega = document.getElementById('pos-tipo-entrega') ? document.getElementById('pos-tipo-entrega').value : 'MOSTRADOR';
            const motorizado = document.getElementById('pos-motorizado') ? document.getElementById('pos-motorizado').value : '';

            const req = {
                cliente_cedula: App.state.clienteActual.cedula,
                descuento_porc: App.state.descPorc, 
                iva_porc: App.state.ivaPorc, 
                puntos_a_canjear: App.state.puntosACanjear,
                metodos_pago: JSON.stringify(jsonMetodos), 
                es_credito: esCredito,
                costo_envio: App.state.costoEnvio,
                tipo_entrega: tipoEntrega,
                motorizado: motorizado,
                inicial_credito: inicialMonto,
                num_cuotas: numCuotas,
                frecuencia_cuotas: frecuencia,
                productos: App.state.carrito.map(c => ({ id: c.id, cantidad: c.cantidad, variante_idx: c.variante_idx }))
            };

            try {
                const res = await fetchAPI('/ventas', { method: "POST", body: JSON.stringify(req) });
                const data = await res.json();
                App.ui.toast(`Venta procesada. Total: $${data.total}`, "success");
                
                const dashCaja = document.getElementById('dash-caja-real'); const dashVentas = document.getElementById('dash-ventas-hoy');
                if (dashCaja) dashCaja.innerText = `$${(parseFloat(dashCaja.innerText.replace('$','')) + data.total).toFixed(2)}`;
                if (dashVentas) dashVentas.innerText = `$${(parseFloat(dashVentas.innerText.replace('$','')) + data.total).toFixed(2)}`;
                
                const nombreSys = App.state.config.nombre_sistema || 'JCLIP';
                if(App.state.clienteActual && App.state.clienteActual.telefono && App.state.clienteActual.telefono !== '0000') {
                    enviarTicketWA(App.state.clienteActual.nombre, App.state.clienteActual.telefono, data.total, data.folio, nombreSys);
                }

                // Limpiar pantalla cliente
                if(posChannel) posChannel.postMessage({ action: 'clear' });

                this.limpiarCaja();
            } catch(e) {}
        },
        limpiarCaja: function() {
            App.state.carrito = []; App.state.clienteActual = null; App.state.puntosACanjear = 0; App.state.costoEnvio = 0;
            if(document.getElementById('ref_pago_digital')) document.getElementById('ref_pago_digital').value = "";
            if(document.getElementById('input-cliente-cedula')) document.getElementById('input-cliente-cedula').value = "";
            if(document.getElementById('input-cliente-nombre')) document.getElementById('input-cliente-nombre').value = "";
            if(document.getElementById('img-preview')) document.getElementById('img-preview').style.display = 'none';
            if(document.getElementById('row-puntos')) document.getElementById('row-puntos').style.display = 'none';
            if(document.getElementById('alerta-puntos')) document.getElementById('alerta-puntos').style.display = 'none';
            if(document.getElementById('cliente-scoring-badge')) document.getElementById('cliente-scoring-badge').style.display = 'none';
            if(document.getElementById('area-credito-config')) document.getElementById('area-credito-config').style.display = 'none';
            this.resetMixto(); this.render(); App.inv.load(); App.crm.load();
            if(document.getElementById('modal-caja-flotante')) document.getElementById('modal-caja-flotante').style.display = 'none';
        }
    },

    print: {
        pdf: function() {
            App.ui.toast("Generando PDF...", "info"); const area = document.getElementById('ticket-area'); if(!area) return;
            document.getElementById('ticket-folio').innerText = `Ticket/Cotización`; document.getElementById('ticket-fecha').innerText = new Date().toLocaleString();
            let htmlProductos = App.state.carrito.map(c => `<div>${c.cantidad}x ${escapeHTML(c.nombre)} - $${round2(c.precio*c.cantidad).toFixed(2)}</div>`).join('');
            let total = document.getElementById('ta-final').innerText;
            let ivaText = document.getElementById('ta-iva').innerText;
            
            const sysName = App.state.config && App.state.config.nombre_sistema ? escapeHTML(App.state.config.nombre_sistema) : 'JCLIP';
            document.getElementById('ticket-header-name').innerText = sysName;

            document.getElementById('ticket-payment-info').innerHTML = `<div style="margin-bottom:10px; border-bottom:1px dashed #000; padding-bottom:5px;"><strong>Cliente:</strong> ${escapeHTML(document.getElementById('input-cliente-cedula').value) || 'General'}<br></div><div style="margin-bottom:10px; border-bottom:1px dashed #000; padding-bottom:5px;">${htmlProductos}</div><div style="font-size:12px; margin-bottom:5px;">IVA: ${ivaText}</div><div style="font-size:14px; font-weight:bold;">TOTAL: ${total}</div>`;
            area.style.display = 'block'; html2pdf().from(area).set({ margin: 5, filename: `Ticket_${sysName}.pdf`, html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: [80, 150], orientation: 'portrait' } }).save().then(() => { area.style.display = 'none'; });
        }
    },

    usuarios: {
        load: async function() { try { const res = await fetchAPI('/usuarios'); const data = await res.json(); App.state.usuarios = data; this.render(App.state.usuarios); } catch(e) { } },
        render: function(lista) {
            const container = document.getElementById('lista-usuarios-ui'); if(!container) return;
            container.innerHTML = lista.map(x=> {
                let avatar = x.foto ? (x.foto.startsWith('http') ? x.foto : BASE_URL + x.foto) : `https://ui-avatars.com/api/?name=${x.nombre}&background=8064F9&color=fff`;
                
                let acciones = '';
                if(x.rol === 'superadmin' && App.state.usuario.rol !== 'superadmin') {
                    acciones = `<span style="font-size:11px; color:var(--danger); font-weight:bold;"><i class="ph-fill ph-lock-key"></i> Dueño</span>`;
                } else {
                    acciones = `<button onclick="App.usuarios.editar(${x.id})" style="background:var(--info-bg); color:var(--info); border:none; padding:6px; border-radius:6px; cursor:pointer;"><i class="ph-bold ph-pencil"></i></button><button onclick="App.usuarios.eliminar(${x.id})" style="background:var(--danger-bg); color:var(--danger); border:none; padding:6px; border-radius:6px; cursor:pointer; margin-left:8px;"><i class="ph-bold ph-trash"></i></button>`;
                }
                
                return `<div style="padding:10px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;"><div style="display:flex; align-items:center; gap:10px;"><img src="${avatar}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;"><div><strong>${escapeHTML(x.nombre)}</strong> (${escapeHTML(x.rol).toUpperCase()})</div></div><div>${acciones}</div></div>`
            }).join('');
        },
        editar: function(id) {
            const u = App.state.usuarios.find(x => x.id === id); if(!u) return;
            document.getElementById('user-id').value = u.id; document.getElementById('user-name').value = u.nombre || ''; document.getElementById('user-pin').value = ''; document.getElementById('user-role').value = u.rol || 'cajero';
            let preview = document.getElementById('user-preview-img');
            if(u.foto) { preview.src = u.foto.startsWith('http') ? u.foto : BASE_URL + u.foto; preview.style.display = 'block'; } else { preview.style.display = 'none'; }
        },
        eliminar: async function(id) {
            if(!confirm("¿Seguro que deseas eliminar este empleado?")) return;
            try { await fetchAPI(`/usuarios/${id}`, { method: 'DELETE' }); App.ui.toast("Usuario Eliminado", "success"); this.load(); } catch(e) {}
        },
        guardarForm: async function(e) {
            e.preventDefault(); const id = document.getElementById('user-id').value; const formData = new FormData();
            formData.append("nombre", document.getElementById('user-name').value); formData.append("pin", document.getElementById('user-pin').value); formData.append("rol", document.getElementById('user-role').value);
            const file = document.getElementById('user-file').files[0]; if(file) formData.append("foto", file);
            try { await fetchAPI(id ? `/usuarios/${id}` : `/usuarios`, { method: id ? "PUT" : "POST", body: formData }); App.ui.toast(id ? "Usuario Actualizado" : "Usuario Creado", "success"); e.target.reset(); document.getElementById('user-id').value = ''; if(document.getElementById('user-preview-img')) document.getElementById('user-preview-img').style.display = 'none'; this.load(); } catch(err) {}
        }
    },

    caja: {
        loadHistorial: async function() { try { const res = await fetchAPI('/caja/totales'); const t = await res.json(); document.getElementById('modal-caja-ingresos').innerText = `$${t.ingresos.toFixed(2)}`; document.getElementById('modal-caja-gastos').innerText = `-$${t.gastos.toFixed(2)}`; } catch(e) {} },
        guardarGasto: async function(e) {
            e.preventDefault(); const req = { categoria: document.getElementById('gasto-cat').value, descripcion: document.getElementById('gasto-desc').value, monto: parseFloat(document.getElementById('gasto-monto').value) };
            try { await fetchAPI('/gastos', {method:"POST", body:JSON.stringify(req)}); App.ui.toast("Gasto Registrado", "success"); let g = parseFloat(document.getElementById('dash-gastos-hoy').innerText.replace('-$',''))||0; document.getElementById('dash-gastos-hoy').innerText = `-$${(g + req.monto).toFixed(2)}`; e.target.reset(); document.getElementById('modal-gasto').style.display='none'; } catch(err) {}
        },
        procesarDevolucion: async function(e) {
            e.preventDefault(); let folio = document.getElementById('dev-folio').value; let monto = parseFloat(document.getElementById('dev-monto').value); let devolverStock = document.getElementById('dev-stock') ? document.getElementById('dev-stock').checked : true;
            try { await fetchAPI('/devolucion', {method:"POST", body:JSON.stringify({folio, monto, devolver_stock: devolverStock})}); App.ui.toast(`Devolución exitosa.`, "success"); let g = parseFloat(document.getElementById('dash-gastos-hoy').innerText.replace('-$',''))||0; document.getElementById('dash-gastos-hoy').innerText = `-$${(g + monto).toFixed(2)}`; e.target.reset(); document.getElementById('modal-devolucion').style.display='none'; App.inv.load(); } catch(err) {}
        },
        calcArqueo: function() {
            let t=0; t+=(parseFloat(document.getElementById('bill-100').value)||0)*100; t+=(parseFloat(document.getElementById('bill-50').value)||0)*50; t+=(parseFloat(document.getElementById('bill-20').value)||0)*20; t+=(parseFloat(document.getElementById('bill-10').value)||0)*10; t+=(parseFloat(document.getElementById('bill-5').value)||0)*5; t+=(parseFloat(document.getElementById('bill-1').value)||0)*1;
            document.getElementById('total-contado-ui').innerText = t.toFixed(2); document.getElementById('arq-real').value = t;
        },
        ejecutarCierre: async function() {
            const req = { contado_usd: parseFloat(document.getElementById('arq-real').value)||0 };
            try { await fetchAPI('/arqueo', {method:"POST", body:JSON.stringify(req)}); App.ui.toast("Cierre y Arqueo Registrado", "success"); document.getElementById('modal-arqueo').style.display='none'; } catch(e) {}
        },
        exportarVentasCSV: async function() {
            try {
                const res = await fetchAPI('/ventas/historial'); const v = await res.json(); let rows = [["Folio", "Fecha", "Total", "Metodos", "Tipo Entrega", "Delivery $"]]; v.forEach(x=>rows.push([x.folio, x.fecha, x.total_usd, x.metodos_pago, x.tipo_entrega || 'MOSTRADOR', x.costo_envio || 0]));
                let csv = "data:text/csv;charset=utf-8," + rows.map(e=>e.join(",")).join("\n"); const link = document.createElement("a"); link.setAttribute("href", encodeURI(csv)); link.setAttribute("download", "Ventas.csv"); document.body.appendChild(link); link.click(); document.body.removeChild(link); App.ui.toast("Excel Descargado", "success");
            } catch(e) {}
        }
    },

    stats: {
        load: async function() {
            try {
                const res = await fetchAPI('/stats'); const d = await res.json();
                document.getElementById('dash-ventas-hoy').innerText = `$${d.ventas_hoy.toFixed(2)}`; 
                document.getElementById('dash-gastos-hoy').innerText = `-$${d.gastos_hoy.toFixed(2)}`; 
                document.getElementById('dash-ganancias').innerText = `$${d.ganancia_neta.toFixed(2)}`; 
                this.renderChart(d.ventas_hoy, d.gastos_hoy, d.ganancia_neta);

                // Cargar Margen Bruto Real y Categorías
                const resUtil = await fetchAPI('/stats/utilidad');
                const u = await resUtil.json();
                const cardsContainer = document.getElementById('utilidad-resumen-cards');
                if(cardsContainer) {
                    cardsContainer.innerHTML = `
                        <div style="background:var(--card-bg); padding:10px; border-radius:8px; border:1px solid var(--border-color); text-align:center;">
                            <span style="font-size:11px; color:var(--text-muted);">Utilidad Bruta Hoy</span>
                            <div style="font-size:16px; font-weight:800; color:var(--success);">$${u.utilidad_bruta_hoy.toFixed(2)}</div>
                        </div>
                        <div style="background:var(--card-bg); padding:10px; border-radius:8px; border:1px solid var(--border-color); text-align:center;">
                            <span style="font-size:11px; color:var(--text-muted);">Margen Real</span>
                            <div style="font-size:16px; font-weight:800; color:var(--primary);">${u.margen_porcentaje_hoy}%</div>
                        </div>
                    `;
                }

                const catList = document.getElementById('utilidad-categorias-lista');
                if(catList) {
                    catList.innerHTML = u.categorias.map(c => `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border-color);">
                            <span><strong>${escapeHTML(c.categoria)}</strong></span>
                            <span>$${c.utilidad.toFixed(2)} <small style="color:var(--success); font-weight:bold;">(${c.margen_porc}%)</small></span>
                        </div>
                    `).join('');
                }
            } catch(e) {}
        },
        renderChart: function(ventas, gastos, neto) {
            const ctx = document.getElementById('ventasChartModal'); if(!ctx) return; if(currentChartVentas) currentChartVentas.destroy();
            currentChartVentas = new Chart(ctx, { type: 'bar', data: { labels: ['Ventas', 'Gastos', 'Neto'], datasets: [{ label: 'Métricas del Día (USD)', data: [ventas, gastos, neto], backgroundColor: ['rgba(16, 185, 129, 0.7)', 'rgba(239, 68, 68, 0.7)', 'rgba(132, 94, 194, 0.7)'], borderColor: ['#10B981', '#EF4444', '#845EC2'], borderWidth: 1, borderRadius: 6 }] }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
        }
    },
    
    creditos: {
        load: async function() {
            try { 
                const res = await fetchAPI('/creditos'); const c = await res.json(); 
                const container = document.getElementById('lista-creditos-ui');
                if(!container) return;

                if(c.length === 0) {
                    container.innerHTML = 'No hay deudas activas';
                    container.classList.add('empty-state');
                    return;
                }

                container.innerHTML = c.map(x => `
                    <div style="padding:12px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong style="color:var(--danger); font-size:13px;">${escapeHTML(x.cliente_nombre)}</strong>
                            <div style="font-size:11px; color:var(--text-muted); margin:2px 0;">Deuda: $${(x.monto_deuda - x.abonado).toFixed(2)} | Folio: ${x.venta_folio}</div>
                            <div style="font-size:11px; color:var(--primary); font-weight:bold;">${x.num_cuotas || 1} cuota(s) (${x.frecuencia || 'MENSUAL'})</div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button onclick="App.creditos.verCuotas(${x.id})" class="btn-outline-blue" style="padding:6px 10px; font-size:11px;"><i class="ph-bold ph-calendar"></i> Cuotas</button>
                            <button onclick="App.creditos.abonar(${x.id}, ${(x.monto_deuda - x.abonado).toFixed(2)})" class="btn-primary-solid" style="padding:6px 10px; font-size:11px;">Abonar</button>
                        </div>
                    </div>
                `).join(''); 
                container.classList.remove('empty-state'); 
            } catch(e) {}
        },
        verCuotas: async function(creditoId) {
            try {
                const res = await fetchAPI(`/creditos/${creditoId}/cuotas`);
                const cuotas = await res.json();
                const container = document.getElementById('cuotas-detalle-content');
                if(!container) return;

                if(cuotas.length === 0) {
                    container.innerHTML = '<p style="text-align:center; color:var(--text-muted);">Sin cronograma de cuotas detallado.</p>';
                } else {
                    container.innerHTML = `
                        <div style="display:flex; flex-direction:column; gap:10px;">
                            ${cuotas.map(cu => {
                                const isPagado = cu.estado === 'PAGADO';
                                return `
                                    <div style="background:var(--card-bg); padding:12px; border-radius:10px; border:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
                                        <div>
                                            <strong style="font-size:13px;">Cuota #${cu.numero_cuota}</strong>
                                            <div style="font-size:11px; color:var(--text-muted);">Vence: ${cu.fecha_vencimiento}</div>
                                            <div style="font-size:14px; font-weight:bold; color:var(--primary); margin-top:2px;">$${cu.monto_cuota.toFixed(2)}</div>
                                        </div>
                                        <div>
                                            ${isPagado 
                                                ? `<span style="color:var(--success); font-weight:bold; font-size:12px;"><i class="ph-bold ph-check-circle"></i> PAGADA</span>`
                                                : `<button onclick="App.creditos.pagarCuota(${cu.id}, ${cu.monto_cuota})" class="btn-primary-solid" style="padding:6px 12px; font-size:12px;">Cobrar Cuota</button>`}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    `;
                }
                document.getElementById('modal-cuotas-detalle').style.display = 'flex';
            } catch(e) {}
        },
        pagarCuota: async function(cuotaId, monto) {
            if(!confirm(`¿Registrar cobro de la cuota por $${monto.toFixed(2)}?`)) return;
            try {
                await fetchAPI(`/creditos/cuota/${cuotaId}/pagar`, { method: "POST", body: JSON.stringify({ monto: monto, metodo_pago: "Efectivo ($)" }) });
                App.ui.toast("Cuota cobrada exitosamente", "success");
                document.getElementById('modal-cuotas-detalle').style.display = 'none';
                await this.load();
                await App.stats.load();
            } catch(e) {}
        },
        abonar: async function(id, deudaRestante) {
            let monto = parseFloat(prompt(`Monto a abonar (Máximo $${deudaRestante}):`, deudaRestante));
            if(isNaN(monto) || monto <= 0 || monto > deudaRestante) return App.ui.toast("Monto inválido", "error");
            const fd = new FormData(); fd.append("monto", monto);
            try { await fetchAPI(`/creditos/abono/${id}`, {method: "POST", body: fd}); App.ui.toast("Abono registrado", "success"); this.load(); } catch(e) {}
        }
    },

    proveedores: {
        load: async function() {
            try {
                const res = await fetchAPI('/proveedores'); App.state.proveedores = await res.json();
                const cBox = document.getElementById('proveedores-checkboxes');
                if(cBox) { cBox.innerHTML = App.state.proveedores.map(p => `<div style="display:inline-block; margin-right:15px; margin-bottom:5px;"><input type="checkbox" class="prov-checkbox" value="${escapeHTML(p.empresa)}" id="prov-${p.id}"><label for="prov-${p.id}">${escapeHTML(p.empresa)}</label></div>`).join(''); }
                const lista = document.getElementById('lista-proveedores-ui');
                if(lista) { lista.innerHTML = App.state.proveedores.map(p => `<div style="padding:10px; border-bottom:1px solid var(--border-color);"><strong>${escapeHTML(p.empresa)}</strong> <span style="font-size:11px; color:var(--text-muted);">- ${escapeHTML(p.vendedor)} (${escapeHTML(p.telefono)})</span></div>`).join(''); lista.classList.remove('empty-state'); }
            } catch(e) {}
        },
        abrirDesdeProducto: function() { document.getElementById('modal-proveedores').style.zIndex = "4005"; document.getElementById('modal-proveedores').style.display = 'flex'; },
        guardarForm: async function(e) {
            e.preventDefault(); const req = { empresa: document.getElementById('prov-empresa').value, vendedor: document.getElementById('prov-nombre').value, telefono: document.getElementById('prov-telefono').value };
            try { await fetchAPI('/proveedores', { method:"POST", body: JSON.stringify(req) }); App.ui.toast("Proveedor Guardado", "success"); e.target.reset(); document.getElementById('modal-proveedores').style.display = 'none'; document.getElementById('modal-proveedores').style.zIndex = "4000"; await this.load(); } catch(err) {}
        },
        generarOrden: function() {
            const bajosStock = App.state.productos.filter(p => p.stock <= (p.stock_minimo !== undefined ? p.stock_minimo : 5)); 
            if(bajosStock.length === 0) return App.ui.toast("Stock óptimo, no requiere orden", "info");
            let orderMap = {};
            bajosStock.forEach(p => {
                let provs = []; try { provs = JSON.parse(p.proveedor); } catch(e){ provs = p.proveedor ? [p.proveedor] : ["Sin Proveedor"]; }
                if(!provs || provs.length === 0) provs = ["Sin Proveedor"];
                let multi = provs.length > 1 ? " <small style='color:orange;'>(Múltiples Prov.)</small>" : "";
                provs.forEach(prov => { if(!orderMap[prov]) orderMap[prov] = []; orderMap[prov].push(`<tr><td style="border:1px solid #ccc; padding:8px;">${escapeHTML(p.codigo)}</td><td style="border:1px solid #ccc; padding:8px;">${escapeHTML(p.nombre)}${multi}</td><td style="border:1px solid #ccc; padding:8px; color:red; font-weight:bold;">${p.stock}</td></tr>`); });
            });
            let htmlFinal = "";
            for(let prov in orderMap) { htmlFinal += `<h3 style="margin-top:20px; color:var(--primary-dark); border-bottom:2px solid #ccc; padding-bottom:5px;">📌 Proveedor: ${escapeHTML(prov)}</h3><table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:12px;"><thead><tr style="background:#eee;"><th style="border:1px solid #ccc; padding:8px;">Código</th><th style="border:1px solid #ccc; padding:8px;">Producto</th><th style="border:1px solid #ccc; padding:8px;">Stock</th></tr></thead><tbody>${orderMap[prov].join('')}</tbody></table>`; }
            document.getElementById('orden-compra-area-content').innerHTML = htmlFinal; const area = document.getElementById('orden-compra-area'); area.style.display = 'block';
            html2pdf().from(area).set({ margin: 10, filename: 'Orden_Compra_JCLIP.pdf' }).save().then(() => { area.style.display = 'none'; App.ui.toast("PDF Generado", "success"); });
        }
    },
    
    db: {
        backup: async function() { 
            try { 
                App.ui.toast("Empaquetando copia de seguridad ZIP...", "info");
                const res = await fetchAPI('/backup/export'); 
                const blob = await res.blob();
                const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download=`jclip_backup_${new Date().toISOString().slice(0,10)}.zip`; document.body.appendChild(a); a.click(); document.body.removeChild(a); 
                App.ui.toast("Backup Descargado Exitosamente", "success"); 
            } catch(e) {} 
        },
        restaurar: async function(e) {
            const file = e.target.files[0];
            if(file) {
                const fd = new FormData(); fd.append("archivo", file);
                try {
                    App.ui.toast("Cargando y restaurando copia...", "info");
                    await fetchAPI('/backup/import', {method: 'POST', body: fd});
                    App.ui.toast("Restauración completada. Recargando sistema...", "success");
                    setTimeout(() => location.reload(), 2500);
                } catch(err) { }
            }
        }
    },

    ui: {
        toast: function(msg, type="info") {
            const c = document.getElementById('toast-container'); if(!c) return;
            const t = document.createElement('div'); t.className = `toast toast-${type}`; t.innerHTML = `<span>${msg}</span>`;
            c.appendChild(t); setTimeout(() => { t.classList.add('toast-hide'); setTimeout(() => t.remove(), 300); }, 3000);
        },
        toggleTheme: function(checkbox) { 
            const isLiquid = checkbox.checked; 
            this.applyTheme(isLiquid ? 'liquid' : 'classic'); 
            localStorage.setItem('jc_theme', isLiquid ? 'liquid' : 'classic'); 
        },
        applyTheme: function(theme) { 
            if(theme === 'liquid') { document.body.classList.add('liquid-theme'); } else { document.body.classList.remove('liquid-theme'); } 
            if (App.state && App.state.config && App.state.config.color) {
                document.body.style.setProperty('--primary', App.state.config.color);
            }
        },
        previewImage: function(input, targetId) {
            if (input.files && input.files[0]) {
                const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
                if(!validTypes.includes(input.files[0].type)) return App.ui.toast("Formato de imagen inválido", "error");
                
                const reader = new FileReader();
                reader.onload = function(e) { 
                    const img = document.getElementById(targetId); img.src = e.target.result; img.style.display = 'block'; 
                    if(input.id === 'config-logo') {
                        img.onload = function() {
                            const domColor = extractDominantColor(img);
                            if(domColor) { 
                                document.getElementById('config-color').value = domColor; 
                                document.documentElement.style.setProperty('--primary', domColor); 
                                document.body.style.setProperty('--primary', domColor);
                                App.ui.toast("Color de marca extraído automáticamente", "success"); 
                            }
                        };
                    }
                }
                reader.readAsDataURL(input.files[0]);
            }
        },
        zoomImage: function(url) {
            const modal = document.getElementById('lightbox-modal');
            const img = document.getElementById('lightbox-img');
            if(modal && img) {
                img.src = url;
                modal.style.display = 'flex';
            }
        },
        closeLightbox: function() {
            document.getElementById('lightbox-modal').style.display = 'none';
        }
    },

    // =========================================================================
    // MÓDULO ASISTENTE VIRTUAL, TOUR INTERACTIVO Y ACADEMIA JCLIP
    // =========================================================================
    tutor: {
        vozActiva: localStorage.getItem('jc_tutor_voz') !== 'false',
        tourActivo: false,
        pasoActualIndex: 0,
        pasos: [],
        moduloActualId: null,
        synth: window.speechSynthesis || null,
        vozSeleccionada: null,

        modulos: [
            {
                id: 'turno',
                titulo: '1. Control de Turnos de Caja',
                subtitulo: 'Apertura con fondo $ y Bs, control y arqueo',
                icono: 'ph-vault',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '.card-turno-master',
                        titulo: 'Panel Maestro de Turnos de Caja',
                        desc: 'Aquí visualizas en tiempo real el estado de la caja registradora, si el turno está abierto o cerrado y qué cajero está a cargo.',
                        speech: 'Bienvenido al módulo de control de turnos. En esta sección puedes supervisar el estado actual de la caja y el cajero responsable.',
                        action: () => switchTab('inicio')
                    },
                    {
                        target: '#btn-abrir-turno-ui, .card-turno-master .btn-primary-solid, .card-turno-master',
                        titulo: 'Apertura de Turno con Fondos',
                        desc: 'Para comenzar el día de ventas, abre el turno registrando el fondo inicial en Dólares ($) y Bolívares (Bs) para los vueltos.',
                        speech: 'Para empezar a facturar, abre el turno ingresando el dinero inicial en dólares y bolívares que usarás para dar vuelto.',
                        action: () => switchTab('inicio')
                    },
                    {
                        target: '#btn-cerrar-turno-ui, .card-turno-master',
                        titulo: 'Cierre Seguro de Turno',
                        desc: 'Al terminar la jornada laboral, el cajero realiza el arqueo ciego para cuadrar la caja con total exactitud y transparencia.',
                        speech: 'Al finalizar la jornada de trabajo, puedes cerrar el turno mediante un arqueo ciego que garantiza la máxima transparencia.',
                        action: () => switchTab('inicio')
                    }
                ]
            },
            {
                id: 'pos',
                titulo: '2. Punto de Venta & Facturación',
                subtitulo: 'Búsqueda por código de barras, clientes y carrito',
                icono: 'ph-receipt',
                tiempo: '3 min',
                pasos: [
                    {
                        target: '#nav-tab-caja',
                        titulo: 'Acceso a la Caja Registradora',
                        desc: 'Haz clic aquí o presiona la tecla F2 para abrir la pantalla flotante de facturación rápida.',
                        speech: 'Con este botón o presionando F2 abres la caja registradora para comenzar a registrar ventas.',
                        action: () => abrirCajaFacturacion()
                    },
                    {
                        target: '#pos-buscador',
                        titulo: 'Lector de Código de Barras & Buscador',
                        desc: 'Puedes disparar tu lector de código de barras USB/Bluetooth o escribir el nombre/SKU del producto.',
                        speech: 'Usa el buscador para escanear artículos con la pistola lectora o buscando directamente por nombre o SKU.'
                    },
                    {
                        target: '#pos-cliente-select',
                        titulo: 'Asignación de Clientes & Puntos',
                        desc: 'Selecciona Ventas Rápidas para clientes casuales o busca clientes registrados para acumular y canjear puntos.',
                        speech: 'Puedes asignar la venta a un cliente registrado para acumular puntos de fidelidad o mantener Ventas Rápidas.'
                    },
                    {
                        target: '#pos-grid-productos',
                        titulo: 'Catálogo Visual & Productos Favoritos',
                        desc: 'Toca o haz clic sobre cualquier producto para añadirlo de inmediato al carrito de compras.',
                        speech: 'En el catálogo puedes presionar cualquier producto para agregarlo a la orden en curso.'
                    },
                    {
                        target: '#pos-carrito-lista',
                        titulo: 'Control de Cantidades y Descuentos',
                        desc: 'Aumenta o disminuye cantidades, aplica descuentos por porcentaje o elimina artículos antes de cobrar.',
                        speech: 'En la lista de la orden puedes modificar cantidades, aplicar descuentos globales o revisar los subtotales.'
                    }
                ]
            },
            {
                id: 'pagos',
                titulo: '3. Métodos de Pago & Vueltos',
                subtitulo: 'Divisas, Pago Móvil, Pagos Mixtos y Tasa BCV',
                icono: 'ph-currency-dollar',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '.payment-methods-grid',
                        titulo: 'Opciones de Pago Disponibles',
                        desc: 'JCLIP admite Efectivo $, Pago Móvil (Bs), Punto de Venta, Zelle, Biopago y Crédito.',
                        speech: 'El sistema te permite cobrar en efectivo, pago móvil, tarjeta por punto de venta, Zelle o crédito.',
                        action: () => abrirCajaFacturacion()
                    },
                    {
                        target: '.method-btn[onclick*="activarPagoMixto"]',
                        titulo: 'Pago Mixto Multidivisa',
                        desc: 'Permite pagar combinando varias monedas (por ejemplo: $10 en efectivo y el resto por Pago Móvil en Bs).',
                        speech: 'La función de pago mixto te permite recibir parte del dinero en dólares y el resto en bolívares en una sola orden.'
                    },
                    {
                        target: '#pos-total-usd',
                        titulo: 'Conversión Automática a Bolívares',
                        desc: 'El total se calcula en tiempo real tanto en Dólares como en Bolívares según la tasa del día.',
                        speech: 'El total a pagar se convierte automáticamente en bolívares a la tasa oficial del día.'
                    },
                    {
                        target: '#btn-completar-venta, .checkout-area-master .btn-primary-solid',
                        titulo: 'Facturar y Enviar Ticket por WhatsApp',
                        desc: 'Guarda la venta, descuenta el stock del inventario y te permite imprimir el ticket o enviarlo al WhatsApp del cliente.',
                        speech: 'Al presionar cobrar, la venta se procesa de inmediato y puedes enviar el ticket digital al WhatsApp del cliente.'
                    }
                ]
            },
            {
                id: 'inventario',
                titulo: '4. Inventario, Kardex & Fotos IA',
                subtitulo: 'Alta de productos, stock mínimo y trazabilidad',
                icono: 'ph-package',
                tiempo: '3 min',
                pasos: [
                    {
                        target: '#nav-tab-inv',
                        titulo: 'Módulo de Inventario',
                        desc: 'Aquí gestionas tus productos, existencias, precios al por mayor y costos de compra.',
                        speech: 'En el inventario puedes consultar y administrar tus productos, existencias y costos.',
                        action: () => switchTab('inventario')
                    },
                    {
                        target: '.inv-header-actions .btn-primary-solid, #btn-nuevo-producto',
                        titulo: 'Creación de Nuevos Productos',
                        desc: 'Registra artículos con fotos recortadas con IA (Remove.bg), stock mínimo y variantes.',
                        speech: 'Crea nuevos productos añadiendo código, nombre, costo, precio de venta y fotos optimizadas con inteligencia artificial.',
                        action: () => switchTab('inventario')
                    },
                    {
                        target: '#btn-kardex-modal, button[onclick*="App.inv.verKardex"]',
                        titulo: 'Trazabilidad en Kardex',
                        desc: 'Supervisa el historial de movimientos: compras, ventas, mermas o ajustes manuales con fecha y responsable.',
                        speech: 'El Kardex registra automáticamente cada entrada, salida o merma de inventario para una auditoría total.',
                        action: () => switchTab('inventario')
                    }
                ]
            },
            {
                id: 'pedidos',
                titulo: '5. Pedidos Remotos & Delivery',
                subtitulo: 'Tablero Kanban de WhatsApp e Instagram',
                icono: 'ph-kanban',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '#modal-kanban .sheet-content',
                        titulo: 'Tablero Kanban Omnicanal',
                        desc: 'Organiza todos los pedidos remotos clasificados en columnas: Pendiente, En Preparación y Enviado.',
                        speech: 'Este tablero te permite controlar los pedidos recibidos por WhatsApp, Delivery o redes sociales en tiempo real.',
                        action: () => { App.pedidos.load(); document.getElementById('modal-kanban').style.display='flex'; }
                    },
                    {
                        target: '.kanban-col:nth-child(1)',
                        titulo: 'Recepción y Validación de Pagos',
                        desc: 'Inspecciona comprobantes de pago móvil o transferencia y asigna el motorizado de entrega.',
                        speech: 'En la columna de pendientes puedes revisar el comprobante de pago del cliente y asignar el motorizado.'
                    },
                    {
                        target: '.kanban-col:nth-child(3)',
                        titulo: 'Despacho y Facturación Automática',
                        desc: 'Al mover el pedido a Entregado o pulsar Facturar, el sistema descuenta el stock y genera el folio de venta.',
                        speech: 'Al marcar el pedido como entregado, el sistema descuenta el inventario y factura la orden de manera automática.'
                    }
                ]
            },
            {
                id: 'creditos',
                titulo: '6. Créditos, Fiados & Cobranzas',
                subtitulo: 'Planes de cuotas, seguimiento de mora y abonos',
                icono: 'ph-handshake',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '#modal-creditos .sheet-content',
                        titulo: 'Módulo de Créditos & Cuentas por Cobrar',
                        desc: 'Consulta todas las deudas activas, clientes con mora y fechas de vencimiento de cuotas.',
                        speech: 'Aquí tienes el control de las cuentas por cobrar, clientes con crédito y vencimiento de cuotas.',
                        action: () => { App.creditos.abrirModal(); }
                    },
                    {
                        target: '#lista-creditos-ui',
                        titulo: 'Cobro de Cuotas y Recibos de Abono',
                        desc: 'Registra abonos parciales o liquidaciones totales emitiendo el comprobante de pago.',
                        speech: 'Puedes registrar abonos y cuotas con diferentes métodos de pago y generar recibos de cobro.'
                    }
                ]
            },
            {
                id: 'cierre',
                titulo: '7. Cierre de Caja & Arqueo Ciego',
                subtitulo: 'Conteo de billetes y cuadre transparente',
                icono: 'ph-lock-key',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '#modal-arqueo .sheet-content',
                        titulo: 'Calculadora de Arqueo Ciego',
                        desc: 'Ingresa la cantidad física de billetes de cada denominación ($100, $50, $20, $10, $5, $1).',
                        speech: 'En el arqueo ciego introduces la cantidad de billetes contados sin ver el total esperado para evitar manipulaciones.',
                        action: () => { document.getElementById('modal-arqueo').style.display='flex'; }
                    },
                    {
                        target: '#total-contado-ui',
                        titulo: 'Cálculo de Diferencia y Registro en Bitácora',
                        desc: 'El sistema calcula si hubo sobrante o faltante y guarda la traza de auditoría con la firma del usuario.',
                        speech: 'El sistema cuadra la caja al instante y guarda el resultado detallado en la bitácora de auditoría.'
                    }
                ]
            },
            {
                id: 'config',
                titulo: '8. Marca Blanca, Tasa BCV & Respaldos',
                subtitulo: 'Personalización de tienda, sincronización y ZIP',
                icono: 'ph-gear-six',
                tiempo: '2 min',
                pasos: [
                    {
                        target: '#header-tasa-display',
                        titulo: 'Sincronización de Tasa Oficial BCV',
                        desc: 'La tasa se actualiza automáticamente todos los días a las 8:00 AM o al presionar el botón de sincronización.',
                        speech: 'El sistema sincroniza la tasa oficial del Banco Central de Venezuela de manera automática o con un solo clic.',
                        action: () => { switchTab('inicio'); }
                    },
                    {
                        target: '#modal-ajustes .sheet-content',
                        titulo: 'Ajustes de Marca Blanca & Copias de Seguridad',
                        desc: 'Configura el nombre de tu empresa, colores corporativos, logo y descarga backups completos en ZIP.',
                        speech: 'En la configuración puedes personalizar tu marca, logotipo, colores del sistema y exportar copias de seguridad en archivo ZIP.',
                        action: () => { document.getElementById('modal-ajustes').style.display='flex'; }
                    }
                ]
            }
        ],

        tourGeneral: [
            {
                target: '.app-header',
                titulo: '¡Bienvenido a JCLIP ERP & POS!',
                desc: 'Este es el encabezado principal, donde ves la identidad de tu empresa, el usuario activo y la tasa oficial del BCV.',
                speech: 'Bienvenido a JCLIP. Este es tu sistema integral de punto de venta, inventario y gestión empresarial.',
                action: () => switchTab('inicio')
            },
            {
                target: '.card-turno-master',
                titulo: '1. Control de Turnos y Caja',
                desc: 'Aquí abres y cierras los turnos de trabajo registrando el fondo inicial en dólares y bolívares.',
                speech: 'En el panel principal controlas los turnos de caja y los fondos iniciales para dar vuelto.'
            },
            {
                target: '#nav-tab-caja',
                titulo: '2. Punto de Venta Inteligente',
                desc: 'Presiona aquí o la tecla F2 para abrir la caja registradora, escanear artículos y facturar a toda velocidad.',
                speech: 'En el punto de venta puedes escanear códigos de barra, seleccionar clientes y cobrar con múltiples métodos de pago.'
            },
            {
                target: '#nav-tab-inv',
                titulo: '3. Inventario & Kardex en Tiempo Real',
                desc: 'Administra productos, precios, alertas de stock mínimo y auditoría completa de movimientos.',
                speech: 'En el inventario gestionas todo tu catálogo con imágenes recortadas con inteligencia artificial y auditoría en Kardex.',
                action: () => switchTab('inventario')
            },
            {
                target: '#nav-tab-kanban',
                titulo: '4. Pedidos WhatsApp & Delivery',
                desc: 'Tablero interactivo para despachar pedidos online, asignar motorizados y facturar en un clic.',
                speech: 'En el tablero de pedidos atiendes clientes de WhatsApp y entregas a domicilio.'
            },
            {
                target: '#assistant-fab',
                titulo: '¡Tu Asistente Virtual Siempre Disponible!',
                desc: 'Puedes tocar este botón en cualquier momento para ingresar a la Academia, repasar lecciones o hacer consultas.',
                speech: 'Estoy siempre a tu disposición en este botón para guiarte en cualquier función del sistema. ¡Mucho éxito en tus ventas!',
                action: () => switchTab('inicio')
            }
        ],

        faqs: [
            {
                q: '¿Cómo abro un nuevo turno de caja?',
                a: 'En el Panel Principal, presiona "Abrir Turno" e ingresa el monto inicial con el que comienzas en dólares y bolívares.',
                accion: () => { switchTab('inicio'); App.tutor.iniciarModulo('turno'); }
            },
            {
                q: '¿Cómo cobro una venta con múltiples monedas (Dólares y Pago Móvil)?',
                a: 'En la pantalla de cobro de Facturación (F2), presiona el botón "Pago Mixto". Podrás ingresar el monto en efectivo y el restante en Pago Móvil.',
                accion: () => { abrirCajaFacturacion(); App.tutor.iniciarModulo('pagos'); }
            },
            {
                q: '¿Cómo agrego un nuevo producto con foto recortada?',
                a: 'Ve a la pestaña Inventario, presiona "+ Nuevo Producto", rellena los datos y sube la foto. Si configuraste Remove.bg, el fondo se recortará automáticamente.',
                accion: () => { switchTab('inventario'); App.tutor.iniciarModulo('inventario'); }
            },
            {
                q: '¿Cómo actualizo la tasa oficial del BCV?',
                a: 'En el encabezado superior, haz clic en el botón de sincronización circular junto al recuadro de la Tasa.',
                accion: () => { switchTab('inicio'); App.config.syncBCV(); }
            },
            {
                q: '¿Cómo realizo el arqueo y cierre de caja?',
                a: 'En el Panel Principal presiona "Cerrar Turno / Arqueo". Cuenta los billetes físicos e ingrésalos en la calculadora ciega.',
                accion: () => { document.getElementById('modal-arqueo').style.display='flex'; App.tutor.iniciarModulo('cierre'); }
            },
            {
                q: '¿Cómo descargo una copia de seguridad (Backup ZIP)?',
                a: 'Abre la Configuración del Dueño y haz clic en "Descargar Copia de Seguridad ZIP". Guardará toda la base de datos y fotos.',
                accion: () => { document.getElementById('modal-ajustes').style.display='flex'; }
            }
        ],

        init: function() {
            this.actualizarBotonVozUI();

            // Cargar voces en síntesis del navegador
            if(this.synth) {
                const cargarVoces = () => {
                    const voces = this.synth.getVoices();
                    this.vozSeleccionada = voces.find(v => v.lang.startsWith('es') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Sabina') || v.name.includes('Helena') || v.name.includes('Microsoft'))) 
                                         || voces.find(v => v.lang.startsWith('es')) || null;
                };
                cargarVoces();
                if(this.synth.onvoiceschanged !== undefined) {
                    this.synth.onvoiceschanged = cargarVoces;
                }
            }

            // Atajos de teclado durante el tour
            document.addEventListener('keydown', (e) => {
                if(!this.tourActivo) return;
                if(e.key === 'Escape') {
                    this.finalizarTour(true);
                } else if(e.key === 'ArrowRight' || e.key === 'Enter') {
                    this.pasoSiguiente();
                } else if(e.key === 'ArrowLeft') {
                    this.pasoAnterior();
                }
            });

            // Reajustar spotlight si la ventana cambia de tamaño
            window.addEventListener('resize', () => {
                if(this.tourActivo && this.pasos[this.pasoActualIndex]) {
                    this.posicionarSpotlight(this.pasos[this.pasoActualIndex]);
                }
            });
        },

        toggleMenu: function(force) {
            const menu = document.getElementById('assistant-menu');
            if(!menu) return;
            if(typeof force === 'boolean') {
                menu.style.display = force ? 'flex' : 'none';
            } else {
                menu.style.display = (menu.style.display === 'flex') ? 'none' : 'flex';
            }
        },

        toggleVoz: function() {
            this.vozActiva = !this.vozActiva;
            localStorage.setItem('jc_tutor_voz', this.vozActiva);
            this.actualizarBotonVozUI();
            if(!this.vozActiva && this.synth) {
                this.synth.cancel();
            } else if(this.vozActiva) {
                this.hablar("Narrador de voz activado.");
            }
        },

        actualizarBotonVozUI: function() {
            const status = document.getElementById('btn-voz-status');
            const icon = document.getElementById('btn-voz-icon');
            if(status) {
                status.innerText = this.vozActiva ? 'ACTIVO' : 'SILENCIADO';
                status.style.color = this.vozActiva ? 'var(--success)' : 'var(--danger)';
            }
            if(icon) {
                icon.className = this.vozActiva ? 'ph-bold ph-speaker-high' : 'ph-bold ph-speaker-slash';
                icon.style.color = this.vozActiva ? 'var(--success)' : 'var(--danger)';
            }
        },

        hablar: function(texto) {
            if(!this.vozActiva || !this.synth || !texto) return;
            try {
                this.synth.cancel();
                const utter = new SpeechSynthesisUtterance(texto);
                if(this.vozSeleccionada) utter.voice = this.vozSeleccionada;
                utter.lang = 'es-ES';
                utter.rate = 1.05;
                utter.pitch = 1.0;

                const wave = document.getElementById('tour-audio-wave');
                utter.onstart = () => { if(wave) wave.style.display = 'inline-flex'; };
                utter.onend = () => { if(wave) wave.style.display = 'none'; };
                utter.onerror = () => { if(wave) wave.style.display = 'none'; };

                this.synth.speak(utter);
            } catch(e) {
                console.warn("SpeechSynthesis error:", e);
            }
        },

        iniciarTourCompleto: function() {
            this.iniciarTour(this.tourGeneral, 'general');
        },

        iniciarModulo: function(moduloId) {
            const mod = this.modulos.find(m => m.id === moduloId);
            if(!mod) return;
            document.getElementById('modal-academia').style.display = 'none';
            document.getElementById('modal-faq').style.display = 'none';
            this.iniciarTour(mod.pasos, mod.id);
        },

        iniciarTour: function(pasos, moduloId) {
            if(!pasos || pasos.length === 0) return;
            this.pasos = pasos;
            this.moduloActualId = moduloId;
            this.pasoActualIndex = 0;
            this.tourActivo = true;

            const overlay = document.getElementById('tour-overlay');
            const spotlight = document.getElementById('tour-spotlight-box');
            const card = document.getElementById('tour-card');

            if(overlay) overlay.style.display = 'block';
            if(spotlight) spotlight.style.display = 'block';
            if(card) card.style.display = 'block';

            this.mostrarPaso(0);
        },

        mostrarPaso: function(index) {
            if(index < 0 || index >= this.pasos.length) return;
            this.pasoActualIndex = index;
            const paso = this.pasos[index];

            if(typeof paso.action === 'function') {
                try { paso.action(); } catch(e) { console.warn("Action error:", e); }
            }

            setTimeout(() => {
                this.posicionarSpotlight(paso);
                this.actualizarCardUI(paso, index);
                this.hablar(paso.speech || paso.desc);
            }, 120);
        },

        posicionarSpotlight: function(paso) {
            let el = null;
            if(paso.target) {
                const selectors = paso.target.split(',');
                for(let sel of selectors) {
                    const found = document.querySelector(sel.trim());
                    if(found && found.offsetParent !== null) {
                        el = found;
                        break;
                    }
                }
            }

            const spotlight = document.getElementById('tour-spotlight-box');
            const card = document.getElementById('tour-card');
            if(!spotlight || !card) return;

            if(el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                const rect = el.getBoundingClientRect();
                const pad = 8;
                const top = Math.max(0, rect.top - pad);
                const left = Math.max(0, rect.left - pad);
                const width = rect.width + (pad * 2);
                const height = rect.height + (pad * 2);

                spotlight.style.top = `${top}px`;
                spotlight.style.left = `${left}px`;
                spotlight.style.width = `${width}px`;
                spotlight.style.height = `${height}px`;
                spotlight.style.display = 'block';

                // Posicionamiento inteligente de la tarjeta
                const cardWidth = 360;
                const cardHeight = 220;
                let cardTop, cardLeft;

                // Preferir debajo si hay espacio
                if(top + height + cardHeight + 20 < window.innerHeight) {
                    cardTop = top + height + 15;
                    cardLeft = Math.min(Math.max(15, left + (width / 2) - (cardWidth / 2)), window.innerWidth - cardWidth - 15);
                } else if(top - cardHeight - 15 > 0) {
                    cardTop = top - cardHeight - 15;
                    cardLeft = Math.min(Math.max(15, left + (width / 2) - (cardWidth / 2)), window.innerWidth - cardWidth - 15);
                } else {
                    cardTop = (window.innerHeight - cardHeight) / 2;
                    cardLeft = (window.innerWidth - cardWidth) / 2;
                }

                card.style.top = `${cardTop}px`;
                card.style.left = `${cardLeft}px`;
            } else {
                // Fallback centrado
                spotlight.style.display = 'none';
                card.style.top = '50%';
                card.style.left = '50%';
                card.style.transform = 'translate(-50%, -50%)';
            }
        },

        actualizarCardUI: function(paso, index) {
            const pill = document.getElementById('tour-step-pill');
            const title = document.getElementById('tour-card-title');
            const desc = document.getElementById('tour-card-desc');
            const btnPrev = document.getElementById('tour-btn-prev');
            const btnNext = document.getElementById('tour-btn-next');

            if(pill) pill.innerHTML = `<i class="ph-bold ph-sparkle"></i> Paso ${index + 1} de ${this.pasos.length}`;
            if(title) title.innerText = paso.titulo || 'Paso del Tour';
            if(desc) desc.innerText = paso.desc || '';

            if(btnPrev) {
                btnPrev.disabled = (index === 0);
                btnPrev.style.opacity = (index === 0) ? '0.4' : '1';
            }

            if(btnNext) {
                const esUltimo = (index === this.pasos.length - 1);
                btnNext.innerHTML = esUltimo ? 'Finalizar <i class="ph-bold ph-check"></i>' : 'Siguiente <i class="ph-bold ph-arrow-right"></i>';
                btnNext.style.background = esUltimo ? 'var(--success)' : 'var(--primary)';
            }
        },

        pasoSiguiente: function() {
            if(this.pasoActualIndex < this.pasos.length - 1) {
                this.mostrarPaso(this.pasoActualIndex + 1);
            } else {
                if(this.moduloActualId && this.moduloActualId !== 'general') {
                    this.marcarModuloCompletado(this.moduloActualId);
                    App.ui.toast("¡Felicitaciones! Módulo completado con éxito 🎓", "success");
                    this.hablar("Excelente trabajo. Has completado esta lección con éxito.");
                } else {
                    App.ui.toast("¡Tour del sistema finalizado con éxito! 🚀", "success");
                    this.hablar("Has terminado el recorrido general. ¡Estás listo para usar JCLIP!");
                }
                setTimeout(() => { this.finalizarTour(); }, 800);
            }
        },

        pasoAnterior: function() {
            if(this.pasoActualIndex > 0) {
                this.mostrarPaso(this.pasoActualIndex - 1);
            }
        },

        repetirVozPasoActual: function() {
            if(this.pasos[this.pasoActualIndex]) {
                const p = this.pasos[this.pasoActualIndex];
                this.hablar(p.speech || p.desc);
            }
        },

        finalizarTour: function(cancelo) {
            this.tourActivo = false;
            if(this.synth) this.synth.cancel();

            const overlay = document.getElementById('tour-overlay');
            const spotlight = document.getElementById('tour-spotlight-box');
            const card = document.getElementById('tour-card');

            if(overlay) overlay.style.display = 'none';
            if(spotlight) spotlight.style.display = 'none';
            if(card) {
                card.style.display = 'none';
                card.style.transform = 'none';
            }
        },

        // --- GESTIÓN DE LA ACADEMIA JCLIP ---
        abrirAcademia: function() {
            this.renderAcademia();
            document.getElementById('modal-academia').style.display = 'flex';
        },

        renderAcademia: function() {
            const grid = document.getElementById('academia-modulos-grid');
            if(!grid) return;

            const completados = this.obtenerCompletados();
            let total = this.modulos.length;
            let countComp = 0;

            grid.innerHTML = this.modulos.map(m => {
                const isDone = completados.includes(m.id);
                if(isDone) countComp++;

                return `
                    <div class="academia-card ${isDone ? 'completado' : ''}">
                        <div class="academia-card-badge ${isDone ? 'badge-completado' : 'badge-pendiente'}">
                            ${isDone ? '<i class="ph-bold ph-check-circle"></i> Completado' : '<i class="ph-bold ph-clock"></i> ' + m.tiempo}
                        </div>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <div class="academia-icon"><i class="ph-fill ${m.icono}"></i></div>
                            <div>
                                <h4 style="margin:0; font-size:14px; font-weight:800; color:var(--text-dark);">${m.titulo}</h4>
                                <p style="margin:2px 0 0 0; font-size:11px; color:var(--text-muted);">${m.subtitulo}</p>
                            </div>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                            <span style="font-size:11px; color:var(--text-muted); font-weight:600;">${m.pasos.length} Pasos interactivos</span>
                            <button class="btn-primary-solid" onclick="App.tutor.iniciarModulo('${m.id}')" style="padding:6px 14px; font-size:11px; display:inline-flex; align-items:center; gap:4px; ${isDone ? 'background:var(--success);' : ''}">
                                ${isDone ? '<i class="ph-bold ph-arrows-clockwise"></i> Repasar' : '<i class="ph-bold ph-play"></i> Iniciar'}
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            const pct = Math.round((countComp / total) * 100);
            const fill = document.getElementById('academia-progreso-fill');
            const texto = document.getElementById('academia-progreso-texto');

            if(fill) fill.style.width = `${pct}%`;
            if(texto) texto.innerText = `${countComp} de ${total} Módulos (${pct}%)`;
        },

        obtenerCompletados: function() {
            try {
                return JSON.parse(localStorage.getItem('jc_completed_tutorials') || '[]');
            } catch(e) {
                return [];
            }
        },

        marcarModuloCompletado: function(moduloId) {
            const list = this.obtenerCompletados();
            if(!list.includes(moduloId)) {
                list.push(moduloId);
                localStorage.setItem('jc_completed_tutorials', JSON.stringify(list));
            }
        },

        // --- GESTIÓN DE PREGUNTAS FRECUENTES (FAQ) ---
        abrirFAQ: function() {
            this.renderFAQ();
            document.getElementById('modal-faq').style.display = 'flex';
        },

        renderFAQ: function() {
            const container = document.getElementById('faq-lista-container');
            if(!container) return;

            container.innerHTML = this.faqs.map((f, idx) => `
                <div class="faq-item-card" onclick="App.tutor.toggleFAQItem(${idx})">
                    <div class="faq-item-q">
                        <span><i class="ph-bold ph-question" style="color:var(--primary); margin-right:6px;"></i> ${f.q}</span>
                        <i id="faq-chevron-${idx}" class="ph-bold ph-caret-down" style="color:var(--text-muted); transition:0.2s;"></i>
                    </div>
                    <div id="faq-answer-${idx}" class="faq-item-a">
                        <p style="margin:6px 0 10px 0;">${f.a}</p>
                        <button class="btn-primary-solid" onclick="event.stopPropagation(); App.tutor.ejecutarFAQ(${idx});" style="padding:6px 14px; font-size:11px; display:inline-flex; align-items:center; gap:6px;">
                            <i class="ph-bold ph-arrow-square-out"></i> Llévame allí & Guiarme
                        </button>
                    </div>
                </div>
            `).join('');
        },

        toggleFAQItem: function(idx) {
            const ans = document.getElementById(`faq-answer-${idx}`);
            const chevron = document.getElementById(`faq-chevron-${idx}`);
            if(!ans) return;
            const isOpen = (ans.style.display === 'block');
            ans.style.display = isOpen ? 'none' : 'block';
            if(chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
        },

        ejecutarFAQ: function(idx) {
            const item = this.faqs[idx];
            if(!item) return;
            document.getElementById('modal-faq').style.display = 'none';
            if(typeof item.accion === 'function') {
                item.accion();
            }
        }
    }
};

function switchTab(tab) { 
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active')); 
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); 
    const v = document.getElementById(`view-${tab}`);
    if(v) v.classList.add('active'); 
    const nav = document.getElementById(`nav-tab-${tab === 'inicio' ? 'inicio' : 'inv'}`);
    if(nav) nav.classList.add('active'); 
}

function abrirCajaFacturacion() { 
    App.pos.render(); 
    document.getElementById('modal-caja-flotante').style.display = 'flex'; 
}

function seleccionarMetodoUnico(metodo, element) { 
    App.state.isMixto = false; 
    document.getElementById('input-metodo-seleccionado').value = metodo; 
    document.querySelectorAll('.method-btn').forEach(btn => btn.classList.remove('active')); 
    element.classList.add('active'); 
    
    const credBox = document.getElementById('area-credito-config');
    if(credBox) credBox.style.display = (metodo === 'Crédito') ? 'block' : 'none';

    App.pos.calcTotal(); 
}

function activarPagoMixto(element) { 
    App.state.isMixto = true; 
    document.getElementById('input-metodo-seleccionado').value = 'Mixto'; 
    document.querySelectorAll('.method-btn').forEach(btn => btn.classList.remove('active')); 
    element.classList.add('active'); 
    
    const credBox = document.getElementById('area-credito-config');
    if(credBox) credBox.style.display = 'none';

    App.pos.calcTotal(); 
}

function actualizarVista() { 
    App.inv.filtrar(document.getElementById('buscador').value); 
}

function enviarTicketWA(c, t, total, id, nombreSys) { 
    if(!t || t.length<5 || t === '0000') return; 
    window.open(`https://wa.me/${t.replace(/\D/g,'')}?text=${encodeURIComponent(`*${nombreSys}*\n\nHola *${c}*, gracias por tu compra.\n🔖 Orden: ${id}\n💰 Total: $${total.toFixed(2)}\n\n_Verificado por ${nombreSys}_`)}`, '_blank'); 
}

document.addEventListener('DOMContentLoaded', () => { App.init(); });
