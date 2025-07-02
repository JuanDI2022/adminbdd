const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const fs = require('fs'); // <--- AÑADE ESTA LÍNEA
const multer = require('multer'); // <--- AÑADE ESTA LÍNEA


const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Sirve los archivos estáticos desde la carpeta 'public' que está un nivel arriba del directorio actual (__dirname)
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

// Ruta para servir el archivo HTML principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.post('/login', async (req, res) => {
    const { usuario, contraseña } = req.body;

    if (!usuario || !contraseña) {
        return res.status(400).json({ success: false, message: 'Por favor ingrese usuario y contraseña.' });
    }

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

app.post('/execute', async (req, res) => {
    if (!req.session.dbConfig) {
        return res.status(401).json({ success: false, message: 'Sesión no válida. Por favor, inicie sesión de nuevo.' });
    }

    const { codigo, incremento, cedula } = req.body;
    let scriptToRun = postgresScripts[codigo];

    if (!scriptToRun) {
        return res.status(400).json({ success: false, message: 'Código de script no válido.' });
    }

    let client;
    try {
        const userPool = new Pool(req.session.dbConfig);
        client = await userPool.connect();

        const notices = [];
        client.on('notice', msg => { notices.push(msg.message); });

        // --- INICIO DE LA CORRECCIÓN: Volver a reemplazo de texto para DO blocks ---
        if (codigo === '9') {
            const step = parseInt(incremento, 10);
            if (isNaN(step) || step < 1) {
                throw new Error('El incremento debe ser un número mayor o igual a 1.');
            }
            // Reemplaza el placeholder en el texto del script
            scriptToRun = scriptToRun.replace('$1', step);
        } else if (codigo === '14') {
            if (!cedula || !/^\d{10}$/.test(cedula)) {
                 throw new Error('La cédula debe contener exactamente 10 dígitos numéricos.');
            }
             // Reemplaza el placeholder en el texto del script
            scriptToRun = scriptToRun.replace('$1', cedula);
        }

        // Ejecutar la consulta con el texto final. No se pasa un array de parámetros.
        await client.query(scriptToRun);
        // --- FIN DE LA CORRECCIÓN ---
        
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

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'No se pudo cerrar la sesión.' });
        }
        res.clearCookie('connect.sid');
        return res.json({ success: true, message: 'Sesión cerrada exitosamente.' });
    });
});

// --- INICIO: CÓDIGO NUEVO PARA AÑADIR (RUTAS PARA REPORTES) ---

// Ruta para obtener las tablas del usuario conectado en PostgreSQL
app.post('/get-tables', async (req, res) => {
    if (!req.session.dbConfig) return res.status(401).json({ success: false, message: 'No autenticado' });
    
    let client;
    try {
        const userPool = new Pool(req.session.dbConfig);
        client = await userPool.connect();
        // Consulta SQL para obtener tablas del esquema actual del usuario
        const result = await client.query(`
            SELECT tablename 
            FROM pg_catalog.pg_tables 
            WHERE schemaname = current_schema()
            ORDER BY tablename
        `);
        // El resultado es un array de objetos, lo convertimos a un array de arrays
        const tables = result.rows.map(row => [row.tablename]);
        res.json({ success: true, tables: tables });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (client) client.release();
    }
});

// Ruta para obtener las columnas de una tabla seleccionada
app.post('/get-columns', async (req, res) => {
    if (!req.session.dbConfig) return res.status(401).json({ success: false, message: 'No autenticado' });
    const { tableName } = req.body;
    
    let client;
    try {
        const userPool = new Pool(req.session.dbConfig);
        client = await userPool.connect();
        // Usamos una consulta parametrizada para seguridad
        const result = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = $1 AND table_schema = current_schema()
            ORDER BY ordinal_position
        `, [tableName]);
        
        const columns = result.rows.map(row => [row.column_name]);
        res.json({ success: true, columns: columns });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (client) client.release();
    }
});


// Ruta para GENERAR el reporte y enviarlo para DESCARGA
app.post('/generate-report', async (req, res) => {
    if (!req.session.dbConfig) return res.status(401).json({ success: false, message: 'No autenticado' });
    
    const { tableName, columns, delimiter, fileName } = req.body;
    if (!tableName || !columns || columns.length === 0 || !delimiter || !fileName) {
        return res.status(400).json({ success: false, message: 'Faltan parámetros.' });
    }

    let client;
    try {
        const userPool = new Pool(req.session.dbConfig);
        client = await userPool.connect();

        // Sanear nombres de columnas para evitar inyección SQL
        const safeColumns = columns.map(col => `"${col}"`).join(', ');
        const safeTableName = `"${tableName}"`;

        const query = `SELECT ${safeColumns} FROM ${safeTableName}`;
        
        const result = await client.query(query);

        // 1. Crear la cabecera del archivo
        const header = columns.join(delimiter);

        // 2. Formatear las filas de datos
        const rows = result.rows.map(row => {
            // Mapeamos los valores de cada fila en el orden de las columnas solicitadas
            return columns.map(col => row[col]).join(delimiter);
        });

        // 3. Unir todo para formar el contenido del archivo
        const fileContent = [header, ...rows].join('\n');

        // 4. Enviar el contenido como un archivo para descargar
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.setHeader('Content-Type', 'text/plain');
        res.send(fileContent);

    } catch (err) {
        console.error("Error en /generate-report:", err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: `Error al generar reporte: ${err.message}` });
        }
    } finally {
        if (client) client.release();
    }
});


// Ruta para SUBIR un archivo, leerlo y devolver su contenido
app.post('/upload-and-read', upload.single('fileToRead'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
    }

    const filePath = req.file.path;

    fs.readFile(filePath, 'utf8', (err, data) => {
        // Borramos el archivo temporal después de leerlo
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error("Error al borrar el archivo temporal:", unlinkErr);
        });

        if (err) {
            return res.status(500).json({ success: false, message: 'Error interno al procesar el archivo.' });
        }
        
        res.json({ success: true, result: data });
    });
});

// --- FIN: CÓDIGO NUEVO PARA AÑADIR ---
app.listen(port, () => {
    console.log(`Servidor Node.js para PostgreSQL ejecutándose en el puerto ${port}`);
    // Crea la carpeta 'uploads' en la raíz del proyecto si no existe
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir);
    }
});


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
            RAISE NOTICE '     - El año % SÍ es bisiesto.', anio;
        ELSE
            RAISE NOTICE '     - El año % NO es bisiesto.', anio;
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
    v_total INTEGER;
BEGIN
    -- Contamos desde pg_class para obtener un número más completo de objetos (tablas, índices, secuencias, etc.)
    SELECT count(*) INTO v_total FROM pg_catalog.pg_class;
    RAISE NOTICE 'Número total de objetos en la BD (tablas, índices, secuencias, etc.): %', v_total;
    CASE
        WHEN v_total < 1000 THEN
            RAISE NOTICE '>> La base de datos tiene una cantidad de objetos estándar.';
        WHEN v_total < 5000 THEN
            RAISE NOTICE '>> La base de datos tiene una cantidad considerable de objetos.';
        ELSE
            RAISE NOTICE '>> La base de datos es grande y contiene muchos objetos.';
    END CASE;
END $$;
`,
    "7": `
DO $$
DECLARE
    v_total INTEGER;
BEGIN
    SELECT count(*) INTO v_total FROM information_schema.tables;
    RAISE NOTICE 'El número total de tablas y vistas en la base de datos es: %', v_total;
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
    v_contador       INTEGER := 0;
    p_incremento     INTEGER := $1; -- Placeholder para reemplazo de texto
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
    `,
    "13": `
DO $$
DECLARE
    -- Declaración del tipo TPERSONA (debe existir a nivel de esquema)
    -- Si no existe, ejecutar: CREATE TYPE TPERSONA AS (CODIGO INT, NOMBRE VARCHAR(100), FECHA_CONTRATACION DATE);
    
    V_LISTA_EMPLEADOS TPERSONA[]; -- Array de tipo TPERSONA
    
    -- Variables para los cálculos de antigüedad
    V_ANOS_ANTIGUEDAD      NUMERIC;
    V_MESES_ANTIGUEDAD     NUMERIC;
    
    -- Variables para el bucle de iteración
    empleado_rec RECORD; -- Un registro genérico para la fila actual del cursor
    idx INTEGER := 1;    -- Índice para llenar el array
    jdx INTEGER;         -- Índice para recorrer el array

BEGIN
    RAISE NOTICE '--- INICIANDO CARGA DE EMPLEADOS DESDE LA TABLA A LA LISTA (TPERSONA[]) ---';

    -- Llenar el array (V_LISTA_EMPLEADOS) con los datos de la tabla 'employees'
    FOR empleado_rec IN SELECT employee_id, first_name, last_name, hire_date FROM employees
    LOOP
        V_LISTA_EMPLEADOS[idx] := (
            empleado_rec.employee_id,
            empleado_rec.first_name || ' ' || empleado_rec.last_name,
            empleado_rec.hire_date
        )::TPERSONA;
        
        RAISE NOTICE 'Cargado en la LISTA [Índice %]: CODIGO: %, NOMBRE: %', idx, V_LISTA_EMPLEADOS[idx].CODIGO, V_LISTA_EMPLEADOS[idx].NOMBRE;
        
        idx := idx + 1;
    END LOOP;

    RAISE NOTICE '--- CARGA COMPLETA. PROCEDIENDO A MOSTRAR DATOS DESDE LA LISTA ---';
    RAISE NOTICE 'Número total de empleados en la lista: %', COALESCE(array_length(V_LISTA_EMPLEADOS, 1), 0);

    IF array_length(V_LISTA_EMPLEADOS, 1) IS NOT NULL AND array_length(V_LISTA_EMPLEADOS, 1) > 0 THEN
        FOR jdx IN array_lower(V_LISTA_EMPLEADOS, 1) .. array_upper(V_LISTA_EMPLEADOS, 1)
        LOOP
            V_ANOS_ANTIGUEDAD  := EXTRACT(YEAR FROM age(CURRENT_DATE, V_LISTA_EMPLEADOS[jdx].FECHA_CONTRATACION));
            V_MESES_ANTIGUEDAD := EXTRACT(MONTH FROM age(CURRENT_DATE, V_LISTA_EMPLEADOS[jdx].FECHA_CONTRATACION));

            RAISE NOTICE 'DE LA LISTA [Índice %]: CODIGO: %, NOMBRE: %, FECHA_CONTRATACION: %, ANTIGUEDAD: % años y % meses.',
                jdx,
                V_LISTA_EMPLEADOS[jdx].CODIGO,
                V_LISTA_EMPLEADOS[jdx].NOMBRE,
                TO_CHAR(V_LISTA_EMPLEADOS[jdx].FECHA_CONTRATACION, 'DD-MM-YYYY'),
                V_ANOS_ANTIGUEDAD,
                V_MESES_ANTIGUEDAD;
        END LOOP;
    ELSE
        RAISE NOTICE 'La lista de empleados está vacía. No hay datos para mostrar.';
    END IF;

    RAISE NOTICE '--- PROCESO COMPLETADO ---';

EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'Error: La tabla "employees" no fue encontrada.';
    WHEN invalid_text_representation THEN
         RAISE NOTICE 'Error: El tipo TPERSONA no existe. Ejecute: CREATE TYPE TPERSONA AS (CODIGO INT, NOMBRE VARCHAR(100), FECHA_CONTRATACION DATE);';
    WHEN OTHERS THEN
        RAISE NOTICE 'Ha ocurrido un error inesperado: %', SQLERRM;
END $$;
    `,
    "14": `
DO $$
DECLARE
    v_cedula_a_validar VARCHAR(10) := '$1'; -- Placeholder para reemplazo de texto
    rec RECORD;
    v_suma_total         INTEGER := 0;
    v_digito_actual      INTEGER;
    v_producto           INTEGER;
    v_digito_verificador_calculado INTEGER;
    v_digito_verificador_real      INTEGER;
BEGIN
    FOR rec IN SELECT v_cedula_a_validar AS cedula LOOP
        RAISE NOTICE '--- Verificando Cédula: % ---', rec.cedula;
        IF LENGTH(rec.cedula) != 10 OR NOT (rec.cedula ~ '^[0-9]+$') THEN
            RAISE EXCEPTION 'Error: La cédula debe tener 10 dígitos numéricos.';
        END IF;
        RAISE NOTICE '--- Proceso del Algoritmo Módulo 10 ---';
        FOR i IN 1..9 LOOP
            v_digito_actual := CAST(SUBSTRING(rec.cedula, i, 1) AS INTEGER);
            IF (i % 2) != 0 THEN
                v_producto := v_digito_actual * 2;
                IF v_producto >= 10 THEN
                    v_producto := v_producto - 9;
                END IF;
                RAISE NOTICE 'Posición % (impar): % * 2 = %', i, v_digito_actual, v_producto;
            ELSE
                v_producto := v_digito_actual * 1;
                RAISE NOTICE 'Posición % (par): % * 1 = %', i, v_digito_actual, v_producto;
            END IF;
            v_suma_total := v_suma_total + v_producto;
        END LOOP;
        RAISE NOTICE '--------------------------------------';
        RAISE NOTICE 'Suma total de los productos: %', v_suma_total;
        v_digito_verificador_calculado := 10 - (v_suma_total % 10);
        IF v_digito_verificador_calculado = 10 THEN
            v_digito_verificador_calculado := 0;
        END IF;
        RAISE NOTICE 'Dígito verificador calculado: %', v_digito_verificador_calculado;
        v_digito_verificador_real := CAST(SUBSTRING(rec.cedula, 10, 1) AS INTEGER);
        RAISE NOTICE 'Último dígito de la cédula (real): %', v_digito_verificador_real;
        IF v_digito_verificador_calculado = v_digito_verificador_real THEN
            RAISE NOTICE '=> Cédula VÁLIDA. Procediendo a insertar en la base de datos.';
            INSERT INTO Tcedulas (nro_cedula) VALUES (rec.cedula);
            RAISE NOTICE 'Cédula % almacenada correctamente.', rec.cedula;
        ELSE
            RAISE EXCEPTION 'CEDULA_INVALIDA';
        END IF;
    END LOOP;
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'Error: La tabla "Tcedulas" no fue encontrada. Por favor, asegúrese de haberla creado.';
    WHEN OTHERS THEN
        IF SQLERRM = 'CEDULA_INVALIDA' THEN
            RAISE NOTICE '=> Cédula INVÁLIDA. El dígito verificador no coincide. No se almacenará en la base de datos.';
        ELSE
            RAISE NOTICE 'Ha ocurrido un error inesperado: %', SQLERRM;
        END IF;
END;
$$
    `
};
