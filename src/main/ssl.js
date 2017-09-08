import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as asn1js from "asn1js";
import * as sudo from "sudo-prompt";
import * as pkijs from "pkijs";
const CryptoOpenSSL = require("node-webcrypto-ossl");

const crypto = new CryptoOpenSSL();
pkijs.setEngine("OpenSSL", crypto, crypto.subtle);

const alg = {
    name: "RSASSA-PKCS1-v1_5",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
    hash: "SHA-256"
};
const hashAlg = "SHA-256";

/**
 * Creates new certificate
 * 
 * @param {CryptoKeyPair}   keyPair     Key pair for new certificate
 * @param {CryptoKey}       caKey       Issuer's private key for cert TBS signing 
 * @returns 
 */
async function GenerateCertificate(keyPair, caKey) {
    const certificate = new pkijs.Certificate();

    //region Put a static values 
    certificate.version = 2;
    const serialNumber = crypto.getRandomValues(new Uint8Array(10));
    certificate.serialNumber = new asn1js.Integer();
    certificate.serialNumber.valueBlock.valueHex = serialNumber.buffer;

    const commonName = new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3", // Common name
        value: new asn1js.PrintableString({ value: "fortifyapp.com" })
    });


    certificate.subject.typesAndValues.push(commonName);
    certificate.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3", // Common name
        value: new asn1js.PrintableString({ value: "Fortify Local CA" })
    }));

    // Valid period is 1 year
    certificate.notBefore.value = new Date(); // current date
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 1);
    certificate.notAfter.value = notAfter;

    certificate.extensions = []; // Extensions are not a part of certificate by default, it's an optional array

    // Extended key usage
    const extKeyUsage = new pkijs.ExtKeyUsage({
        keyPurposes: ["1.3.6.1.5.5.7.3.1"],
    });
    certificate.extensions.push(new pkijs.Extension({
        extnID: "2.5.29.37",
        critical: true,
        extnValue: extKeyUsage.toSchema().toBER(false),
        parsedValue: extKeyUsage
    }));

    // Subject alternative name
    const subjectAlternativeName = new pkijs.AltName({
        altNames: [
            new pkijs.GeneralName({
                type: 2,
                value: "localhost",
            }),
            new pkijs.GeneralName({
                type: 7,
                value: new asn1js.OctetString({ valueHex: new Uint8Array(new Buffer("7F000001", "hex")).buffer }),
            }),
        ]
    });
    certificate.extensions.push(new pkijs.Extension({
        extnID: "2.5.29.17",
        critical: false,
        extnValue: subjectAlternativeName.toSchema().toBER(false),
        parsedValue: subjectAlternativeName
    }));

    // Basic constraints
    const basicConstraints = new pkijs.BasicConstraints({
        cA: false,
    });
    certificate.extensions.push(new pkijs.Extension({
        extnID: "2.5.29.19",
        critical: false,
        extnValue: basicConstraints.toSchema().toBER(false),
        parsedValue: basicConstraints
    }));

    await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
    await certificate.sign(caKey, hashAlg);

    return certificate;
}

/**
 * Creates CA certificate
 * 
 * @param {CryptoKeyPair}   keyPair     Key pair of CA cert
 * @returns 
 */
async function GenerateCertificateCA(keyPair) {
    const certificate = new pkijs.Certificate();

    //region Put a static values 
    certificate.version = 2;
    const serialNumber = crypto.getRandomValues(new Uint8Array(10));
    certificate.serialNumber = new asn1js.Integer();
    certificate.serialNumber.valueBlock.valueHex = serialNumber.buffer;

    const commonName = new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3", // Common name
        value: new asn1js.PrintableString({ value: "Fortify Local CA" })
    });

    certificate.issuer.typesAndValues.push(commonName);
    certificate.subject.typesAndValues.push(commonName);

    // Valid period is 1 year
    certificate.notBefore.value = new Date(); // current date
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 1);
    certificate.notAfter.value = notAfter;

    certificate.extensions = []; // Extensions are not a part of certificate by default, it's an optional array

    // Basic constraints
    const basicConstraints = new pkijs.BasicConstraints({
        cA: true,
        pathLenConstraint: 2
    });
    certificate.extensions.push(new pkijs.Extension({
        extnID: "2.5.29.19",
        critical: false,
        extnValue: basicConstraints.toSchema().toBER(false),
        parsedValue: basicConstraints
    }));

    await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
    await certificate.sign(keyPair.privateKey, hashAlg);

    return certificate;
}

/**
 * Generates key pair for sign/verify
 * 
 * @returns {Promise<CryptoKeyPair>} 
 */
async function GenerateKey() {
    return crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
}

/**
 * Returns crypto key in PEM format
 * 
 * @param {CryptoKey} key 
 * @returns {Promise<string>}
 */
async function ConvertKeyToPEM(key) {
    const format = key.type === "public" ? "spki" : "pkcs8";
    const der = await crypto.subtle.exportKey(format, key);
    return ConvertToPEM(der, `RSA ${key.type.toUpperCase()} KEY`);
}

/**
 * Returns DER buffer in PEM format
 * 
 * @param {ArrayBuffer}     der     Incoming buffer of PKI object 
 * @param {string}          tag     tag name for BEGIN/END block
 * @returns {string}
 */
function ConvertToPEM(der, tag) {
    const derBuffer = new Buffer(der);
    const b64 = derBuffer.toString("base64");
    const stringLength = b64.length;
    let pem = "";

    for (let i = 0, count = 0; i < stringLength; i++ , count++) {
        if (count > 63) {
            pem = `${pem}\r\n`;
            count = 0;
        }
        pem = `${pem}${b64[i]}`;
    }

    tag = tag.toUpperCase();
    const pad = "-----";
    return `${pad}BEGIN ${tag}${pad}\r\n${pem}\r\n${pad}END ${tag}${pad}\r\n`;
}

/**
 * @typedef {Object} ISslGenerateResult
 * 
 * @property {Buffer}   root    CA cert in PEM format
 * @property {Buffer}   cert    localhost cert in PEM format
 * @property {Buffer}   key     private key of localhost cert in PEM format
 * 
 */

/**
 * Generates SSL cert chain (CA + localhost)
 * 
 * @export
 * @returns {Promise<ISslGenerateResult>}
 */
export async function generate() {
    const root_keys = await GenerateKey();
    const root_cert = await GenerateCertificateCA(root_keys);
    const localhost_keys = await GenerateKey();
    const localhost_cert = await GenerateCertificate(localhost_keys, root_keys.privateKey);
    const key_pem = await ConvertKeyToPEM(localhost_keys.privateKey);

    const root_cert_pem = ConvertToPEM(root_cert.toSchema(true).toBER(false), "CERTIFICATE");
    const localhost_cert_pem = ConvertToPEM(localhost_cert.toSchema(true).toBER(false), "CERTIFICATE");

    return {
        root: new Buffer(root_cert_pem),
        cert: new Buffer(localhost_cert_pem),
        key: new Buffer(key_pem),
    };
}

/**
 * Installs cert to trusted stores
 * 
 * @export
 * @param {string}  certPath    Path to cert which must be installed to trusted store
 */
export async function InstallTrustedCertificate(certPath) {
    const platform = os.platform();
    switch (platform) {
        case "darwin":
            await InstallTrustedOSX(certPath);
            break;
        case "win32":
            await InstallTrustedWindows(certPath);
            break;
        case "linux":
        default:
            throw new Error(`Unsupported OS platform '${platform}'`)
    }

}

/**
 * Installs trusted cert on OS X
 * 
 * @param {string}  certPath Path to cert
 */
async function InstallTrustedOSX(certPath) {
    // install certificate to system key chain
    await new Promise((resolve, reject) => {
        const options = {
            name: "Fortify application",
            icons: "/Applications/Fortify.app/Contents/Resources/icons/icon.icns"
        };
        const appPath = path.dirname(certPath);
        const username = os.userInfo().username;
        sudo.exec(`appPath=${appPath} userDir=${os.homedir()} USER=${username} bash ${__dirname}/../src/resources/osx-ssl.sh`, options, (err, stdout) => {
            // console.log(stdout.toString());
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });

}

/**
 * Installs trusted cert on Windows
 * 
 * @param {string}  certPath Path to cert
 */
async function InstallTrustedWindows(certPath) {
    const USER_HOME = os.homedir();
    const FIREFOX_DIR = path.normalize(`${USER_HOME}/AppData/Roaming/Mozilla/Firefox/Profiles`);
    const CERTUTIL = path.normalize(`${__dirname}\\..\\..\\certutil.exe`);
    const CERT_NAME = `Fortify Local CA`;

    // check Firefox was installed
    if (fs.existsSync(FIREFOX_DIR)) {
        // get profiles
        fs.readdirSync(FIREFOX_DIR).map((item) => {
            const PROFILE_DIR = `${FIREFOX_DIR}\\${item}`;
            if (fs.existsSync(PROFILE_DIR)) {
                child_process.execSync(`"${CERTUTIL}" -D -n "${CERT_NAME}" -d "${PROFILE_DIR}" | "${CERTUTIL}" -A -i "${certPath}" -n "${CERT_NAME}" -t "C,c,c" -d "${PROFILE_DIR}"`);
                // restart firefox
                try {
                    child_process.execSync(`taskkill /F /IM firefox.exe`);
                    child_process.execSync(`start firefox`);
                } catch (err) {
                    // firefox is not running
                }
            }
        })
    }

    child_process.execSync(`certutil -addstore -user root "${certPath}"`);
}