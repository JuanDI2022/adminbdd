const path = require('path');
// Le decimos a dotenv que el archivo .env está en la carpeta padre (la raíz del proyecto)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const { Pool } = require('pg');
const session = require('express-session'); // Este paquete es crucial para logins individuales

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
    secret: 'una_frase_muy_secreta_y_larga_para_proteger_las_sesiones',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false, // <--- CAMBIA ESTO TEMPORALMENTE A FALSE PARA PROBAR EN HTTP
        httpOnly: true, // Siempre es buena práctica mantener esto
        sameSite: 'Lax' // También es buena práctica
    } 
}));


// --- Rutas de la Aplicación ---

// RUTA DE LOGIN CORREGIDA Y SEGURA
app.post('/login', async (req, res) => {
    const { usuario, contraseña } = req.body;

    if (!usuario || !contraseña) {
        return res.status(400).json({ success: false, message: 'Por favor ingrese usuario y contraseña.' });
    }

    // Crea una configuración de conexión específica para el usuario que intenta iniciar sesión
    const userDbConfig = {
        user: usuario,
        password: contraseña,
        host: process.env.PGHOST,
        database: process.env.PGDATABASE,
        port: process.env.PGPORT,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000, 
    };

    let client;
    try {
        const tempPool = new Pool(userDbConfig);
        client = await tempPool.connect();
        await client.query('SELECT 1');

        // ==============================================================================
        //      AQUÍ ESTABA EL ERROR DE TIPEO CORREGIDO: 'userDbConfig'
        // Si la consulta anterior tuvo éxito, guardamos la configuración en la sesión.
        // ==============================================================================
        req.session.dbConfig = userDbConfig;
        
        console.log(`Login exitoso para el usuario: ${usuario}`);
        res.json({ success: true, message: 'Conexión exitosa' });

    } catch (err) {
        console.error(`Fallo de autenticación para ${usuario}:`, err.message);
        res.status(401).json({ success: false, message: `Usuario o contraseña incorrectos.` });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// =====================================================================
//                  AQUÍ ESTÁ LA CORRECCIÓN
// =====================================================================
// La ruta de ejecución AHORA SÍ encontrará la sesión
app.post('/execute', async (req, res) => {
    if (!req.session.dbConfig) {
        return res.status(401).json({ success: false, message: 'Sesión no válida. Por favor, inicie sesión de nuevo.' });
    }

    const { codigo, incremento } = req.body;
    let scriptToRun = postgresScripts[codigo]; // Obtenemos la plantilla del script

    if (!scriptToRun) {
        return res.status(400).json({ success: false, message: 'Código de script no válido.' });
    }

    let client;
    try {
        const userPool = new Pool(req.session.dbConfig);
        client = await userPool.connect();

        const notices = [];
        client.on('notice', msg => { notices.push(msg.message); });

        let params = []; // Por defecto, no hay parámetros

        // CORRECCIÓN: Manejo especial para el script #9
        if (codigo === '9') {
            const step = parseInt(incremento, 10);
            if (isNaN(step) || step < 1) {
                throw new Error('El incremento debe ser un número mayor o igual a 1.');
            }
            // En lugar de enviar un parámetro, reemplazamos el texto en el script.
            // Esto es seguro porque 'step' ya fue validado como un número.
            scriptToRun = scriptToRun.replace('$1', step);
        }

        // Ejecutamos el script. Para el #9, 'params' estará vacío y el valor ya está en el string.
        await client.query(scriptToRun, params);
        
        const output = notices.join('\n');
        res.json({ success: true, result: output || 'Ejecución completada sin mensajes de salida.' });

    } catch (err) {
        console.error('Error al ejecutar script:', err);
        res.status(500).json({ success: false, message: `Error al ejecutar: ${err.message}` });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// La ruta de Logout ahora destruye la sesión
app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'No se pudo cerrar la sesión.' });
        }
        res.clearCookie('connect.sid'); // Limpia la cookie del navegador
        return res.json({ success: true, message: 'Sesión cerrada exitosamente.' });
    });
});


app.listen(port, () => {
    console.log(`Servidor Node.js para PostgreSQL ejecutándose en el puerto ${port}`);
});



// CAMBIO PRINCIPAL: Los scripts ya no son llamadas a funciones.
// Ahora son bloques de código PL/pgSQL completos y "quemados" en el código.
const postgresScripts = {
    "1": `
DO $$
DECLARE
    v_char CHAR(25) := 'Texto de longitud fija';
    v_text TEXT := 'Hola Mundo desde PostgreSQL';
    v_numeric NUMERIC(15, 2) := 470540545470.45;
    v_integer INTEGER := 12345;
    v_boolean BOOLEAN := TRUE;
    v_real REAL := 123.456;
    v_double DOUBLE PRECISION := 987654.321;
    v_date DATE := CURRENT_DATE;
    v_timestamp TIMESTAMP := NOW();
    v_timestamptz TIMESTAMPTZ := NOW();
    v_interval_ym INTERVAL YEAR TO MONTH := '5 years 3 months';
    v_interval_ds INTERVAL DAY TO SECOND := '10 days 08:30:15.55';
BEGIN
    RAISE NOTICE '--- INICIO DE EJEMPLOS DE TIPOS DE DATO EN POSTGRESQL ---';
    RAISE NOTICE '1. CHAR: %', v_char;
    RAISE NOTICE '2. TEXT (VARCHAR): %', v_text;
    RAISE NOTICE '3. NUMERIC: %', v_numeric;
    RAISE NOTICE '4. INTEGER: %', v_integer;
    RAISE NOTICE '5. BOOLEAN: %', v_boolean;
    RAISE NOTICE '6. REAL (float4): %', v_real;
    RAISE NOTICE '7. DOUBLE PRECISION (float8): %', v_double;
    RAISE NOTICE '8. DATE: %', TO_CHAR(v_date, 'DD-MON-YYYY');
    RAISE NOTICE '9. TIMESTAMP: %', TO_CHAR(v_timestamp, 'DD-MON-YYYY HH24:MI:SS');
    RAISE NOTICE '10. TIMESTAMP WITH TIME ZONE: %', v_timestamptz;
    RAISE NOTICE '11. INTERVAL YEAR TO MONTH: %', v_interval_ym;
    RAISE NOTICE '12. INTERVAL DAY TO SECOND: %', v_interval_ds;
    RAISE NOTICE '--- FIN DEL PROGRAMA ---';
END $$;
    `,
    "2": `
DO $$
DECLARE
    v_fecha_base DATE := TO_DATE('2024-02-29', 'YYYY-MM-DD');
BEGIN
    RAISE NOTICE '--- CÁLCULOS A PARTIR DE LA FECHA: % ---', TO_CHAR(v_fecha_base, 'DD-MON-YYYY');
    RAISE NOTICE '1. Día Siguiente: %', TO_CHAR(v_fecha_base + 1, 'DD-MON-YYYY');
    RAISE NOTICE '2. Día Anterior: %', TO_CHAR(v_fecha_base - 1, 'DD-MON-YYYY');
    RAISE NOTICE '3. Año Siguiente (usando Intervalo): %', TO_CHAR(v_fecha_base + INTERVAL '1 year', 'DD-MON-YYYY');
    RAISE NOTICE '4. Año Anterior (usando Intervalo): %', TO_CHAR(v_fecha_base - INTERVAL '1 year', 'DD-MON-YYYY');
    RAISE NOTICE '5. Último día del mes: %', TO_CHAR((DATE_TRUNC('MONTH', v_fecha_base) + INTERVAL '1 MONTH - 1 DAY')::DATE, 'DD-MON-YYYY');
    RAISE NOTICE '6. Primer día del año: %', TO_CHAR(DATE_TRUNC('YEAR', v_fecha_base)::DATE, 'DD-MON-YYYY');
    RAISE NOTICE '7. Fecha + 45 días: %', TO_CHAR(v_fecha_base + 45, 'DD-MON-YYYY');
    RAISE NOTICE '8. Nombre del día: %', TO_CHAR(v_fecha_base, 'Day');
    RAISE NOTICE '9. Días para fin de año: %', (DATE_TRUNC('YEAR', v_fecha_base) + INTERVAL '1 YEAR')::DATE - v_fecha_base;
    RAISE NOTICE '10. Verificación de Años Bisiestos:';
    FOR anio IN 2023..2026 LOOP
        IF to_char( (TO_DATE(anio || '-03-01', 'YYYY-MM-DD') - INTERVAL '1 day'), 'DD') = '29' THEN
            RAISE NOTICE '    - El año % SÍ es bisiesto.', anio;
        ELSE
            RAISE NOTICE '    - El año % NO es bisiesto.', anio;
        END IF;
    END LOOP;
    RAISE NOTICE '--- FIN DEL PROGRAMA ---';
END $$;
    `,
"3": `
DO $$
DECLARE
    v_numero_empleados INTEGER;
    v_usuario_actual TEXT;
BEGIN
    -- Bloque para contar empleados con manejo de errores
    BEGIN
        SELECT count(*) INTO v_numero_empleados FROM employees;
        RAISE NOTICE 'Número total de empleados: %', v_numero_empleados;
    EXCEPTION
        WHEN undefined_table THEN
            RAISE NOTICE 'Error: La tabla "employees" no fue encontrada. Por favor, asegúrese de haberla creado.';
        WHEN OTHERS THEN
            RAISE NOTICE 'Ocurrió un error inesperado al contar los empleados: %', SQLERRM;
    END;

    -- Obtener y mostrar el usuario actual
    SELECT current_user INTO v_usuario_actual;
    RAISE NOTICE 'Script ejecutado por el usuario: %', v_usuario_actual;
END $$;
`,
    "4": `
DO $$
DECLARE
    v_db_name TEXT;
    v_server_start_time TIMESTAMPTZ;
BEGIN
    RAISE NOTICE '--- Información de la BD (PostgreSQL) ---';
    SELECT current_database() INTO v_db_name;
    RAISE NOTICE 'Nombre de la BD: %', v_db_name;
    SELECT pg_postmaster_start_time() INTO v_server_start_time;
    RAISE NOTICE 'Fecha de inicio del servidor: %', TO_CHAR(v_server_start_time, 'DD-MON-YYYY HH24:MI:SS');
END $$;
    `,
    "5": `
DO $$
DECLARE
    v_server_start_time    TIMESTAMPTZ;
    v_elapsed_interval     INTERVAL;
BEGIN
    -- 1. Obtener la hora de inicio del servidor
    SELECT pg_postmaster_start_time() INTO v_server_start_time;
    RAISE NOTICE 'El servidor fue iniciado exactamente el: %', TO_CHAR(v_server_start_time, 'DD-Mon-YYYY a las HH24:MI:SS');
    RAISE NOTICE ''; -- Línea en blanco para separar

    -- 2. Calcular el intervalo de tiempo transcurrido usando la función age()
    v_elapsed_interval := age(NOW(), v_server_start_time);
    
    -- 3. Mostrar el tiempo transcurrido de forma detallada
    RAISE NOTICE 'Tiempo exacto transcurrido desde el inicio:';
    -- La función age() ya formatea el intervalo de forma legible, pero la mostraremos por partes.
    RAISE NOTICE '% Días, % Horas, % Minutos y % Segundos', 
        EXTRACT(DAY FROM v_elapsed_interval),
        EXTRACT(HOUR FROM v_elapsed_interval),
        EXTRACT(MINUTE FROM v_elapsed_interval),
        floor(EXTRACT(SECOND FROM v_elapsed_interval));
    RAISE NOTICE ''; -- Línea en blanco para separar

    -- 4. Mantener la lógica de los 30 días
    IF (NOW() - v_server_start_time > INTERVAL '30 days') THEN
        RAISE NOTICE '>> El servidor fue iniciado hace MÁS de 30 días.';
    ELSE
        RAISE NOTICE '>> El servidor fue iniciado hace MENOS de 30 días.';
    END IF;
END $$;
`,
         "6": `
DO $$
DECLARE
    v_total_objetos  INTEGER;
    v_total_tablas   INTEGER;
    v_total_indices  INTEGER;
BEGIN
    -- Conteo total de objetos (incluye tablas, índices, secuencias, vistas, etc.)
    SELECT count(*) INTO v_total_objetos FROM pg_catalog.pg_class;

    -- Conteo específico de tablas (relkind = 'r' para 'relation')
    SELECT count(*) INTO v_total_tablas FROM pg_catalog.pg_class WHERE relkind = 'r';

    -- Conteo específico de índices (relkind = 'i' para 'index')
    SELECT count(*) INTO v_total_indices FROM pg_catalog.pg_class WHERE relkind = 'i';

    RAISE NOTICE '--- ANÁLISIS DE OBJETOS DE LA BASE DE DATOS ---';
    RAISE NOTICE 'Total de objetos encontrados: %', v_total_objetos;
    RAISE NOTICE ''; -- Línea en blanco para separar
    -- Lógica de comparación con 250
    IF v_total_objetos > 250 THEN
        RAISE NOTICE '>> La base de datos tiene MÁS de 250 objetos.';
    ELSE
        RAISE NOTICE '>> La base de datos tiene MENOS de 250 objetos.';
    END IF;
END $$;
`,
    "7": `
DO $$
DECLARE
    v_total_objetos INTEGER;
BEGIN
    -- Usamos pg_class que cataloga todos los objetos (tablas, índices, secuencias, vistas, etc.)
    SELECT count(*) INTO v_total_objetos FROM pg_catalog.pg_class;
    RAISE NOTICE 'El número total de objetos en la base de datos es: %', v_total_objetos;
END $$;
`,
    "8": `
DO $$
BEGIN
    RAISE NOTICE 'Iniciando bucle simple:';
    FOR i IN 1..10 LOOP
        RAISE NOTICE 'Número: %', i;
    END LOOP;
    RAISE NOTICE 'Bucle finalizado.';
END $$;
    `,
    "9": `
DO $$
DECLARE
    v_num_inicial    INTEGER;
    v_numero_actual INTEGER;
    v_contador      INTEGER := 0;
    p_incremento    INTEGER := $1; -- El parámetro se recibe aquí
BEGIN
    SELECT COALESCE(MAX(num), 0) + 1 INTO v_num_inicial FROM tbl_num;
    v_numero_actual := v_num_inicial;
    RAISE NOTICE 'Iniciando inserción de 10 números, desde % con incremento de %.', v_numero_actual, p_incremento;
    WHILE v_contador < 10 LOOP
        INSERT INTO tbl_num (num) VALUES (v_numero_actual);
        RAISE NOTICE ' -> Guardado en tabla: %', v_numero_actual;
        v_numero_actual := v_numero_actual + p_incremento;
        v_contador := v_contador + 1;
    END LOOP;
    RAISE NOTICE 'Proceso completado con éxito.';
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'Error: La tabla TBL_NUM no existe. Por favor, ejecute el script #10 para crearla.';
    WHEN OTHERS THEN
        RAISE NOTICE 'Ha ocurrido un error durante la inserción: %', SQLERRM;
END $$;
    `,
    "10": `
DO $$
BEGIN
    CREATE TABLE IF NOT EXISTS tbl_num (
        num            INTEGER NOT NULL PRIMARY KEY,
        fecha_registro TIMESTAMPTZ DEFAULT NOW()
    );
    RAISE NOTICE 'Tabla TBL_NUM verificada/creada exitosamente.';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error inesperado al crear la tabla TBL_NUM: %', SQLERRM;
END $$;
    `,
    "11": `
DO $$
BEGIN
    RAISE NOTICE '--- NÚMEROS PARES DEL 1 AL 10 ---';
    FOR v_num IN 1..10 LOOP
        IF (v_num % 2) = 0 THEN
            RAISE NOTICE 'NÚMERO PAR: %', v_num;
        END IF;
    END LOOP;
END $$;
    `,
    "12": `
DO $$
BEGIN
    RAISE NOTICE '--- NÚMEROS IMPARES DEL 1 AL 10 ---';
    FOR v_num IN 1..10 LOOP
        IF (v_num % 2) != 0 THEN
            RAISE NOTICE 'NÚMERO IMPAR: %', v_num;
        END IF;
    END LOOP;
END $$;
    `
};
