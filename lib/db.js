//
// How the database is named, in the forms the environments actually use.
//
// This lives here rather than inside import.js because deploy-import.sh now
// backs the database up before it writes to it, and the backup has to resolve
// to the same server, user and schema the importer is about to touch. A backup
// of a different database is worse than no backup at all, because it looks
// like one. So both read the environment through this file.
//
// DSN is only handed to mysql2 when it is a URI, because that is the one form
// mysql2 parses. Production sets DSN in the Go driver's own format instead -
// user:pass@tcp(host:port)/dbname - which mysql2 accepts without complaint and
// silently mangles: user comes out undefined, password empty, host localhost
// and the database "assword@tcp(...)". What reaches you is "Access denied for
// user ''", which names none of that. So the Go form is parsed here instead,
// and a DSN in neither form is ignored out loud rather than quietly.

function fromParts(){
    return {
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || "ddadmin",
        password: process.env.DB_PASSWORD || "password",
        database: process.env.DB_NAME || "divinedrop",
    };
}

function resolveDb(){
    const dsn = (process.env.DSN || "").trim();
    if (!dsn){
        return { config: fromParts(), source: "DB_*" };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dsn)){
        return { config: dsn, source: "DSN as a uri" };
    }
    // user:pass@tcp(host:port)/dbname?params - the net and address are optional
    // in the Go format, and so is the credential pair.
    const go = dsn.match(/^(?:([^:@/]*)(?::([^@]*))?@)?[a-z]*(?:\(([^)]*)\))?\/([^?]+)/i);
    if (go){
        const [, user, password, addr, database] = go;
        const [host, port] = (addr || "").split(":");
        const parts = fromParts();
        return {
            config: {
                host: host || parts.host,
                port: Number(port) || parts.port,
                user: user || parts.user,
                password: password ?? parts.password,
                database: database || parts.database,
            },
            source: "DSN in the Go driver format",
        };
    }
    return { config: fromParts(), source: "DB_* (DSN is set but in no form this understands, so it was ignored)" };
}

// The same database as five separate values. mysql2 takes a uri as it stands;
// mysqldump cannot, and needs the host, port, user, password and schema name on
// their own - so the one form resolveDb leaves as a string is taken apart here.
function resolveParts(){
    const { config, source } = resolveDb();
    if (typeof config !== "string"){
        return { ...config, source };
    }
    const parts = fromParts();
    let uri;
    try {
        uri = new URL(config);
    } catch (error){
        return { ...parts, source: `${source}, which does not parse as one - DB_* used instead` };
    }
    const decode = (value) => {
        try {
            return decodeURIComponent(value);
        } catch (error){
            return value;
        }
    };
    // A uri that names a user is trusted for the password too, empty included.
    // One that names no user falls back to DB_* for both rather than pairing a
    // uri host with a password from somewhere else.
    const credentialled = uri.username !== "";
    return {
        host: uri.hostname || parts.host,
        port: Number(uri.port) || parts.port,
        user: credentialled ? decode(uri.username) : parts.user,
        password: credentialled ? decode(uri.password) : parts.password,
        database: decodeURIComponent(uri.pathname.replace(/^\//, "")) || parts.database,
        source,
    };
}

function describe(target){
    if (typeof target === "string"){
        return target.replace(/\/\/[^:@/]*:[^@/]*@/, "//***:***@");
    }
    return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

module.exports = { fromParts, resolveDb, resolveParts, describe };
