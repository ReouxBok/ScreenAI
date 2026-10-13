export const STAGING_EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAptqKEu2qncjMYVBcI7AFyjNP3pCa7YF/NKrv6hEgXItdmLak7Z09u1crVhxCsaFoqtzhn7A1M/r7ElAXbDserRyQX68Nkgacs1j4x8vTK8feECMfz6aZz7lhSMJWtJizoTLdfoSdDN9innZJ++PtG9dBF4j4y//ieulkK+ND8FPimMh0ZKmviVudQeAop5m5P/OJhKTwTEFjrdrVcHopYpXrOO1k8U99cga00ot9E+nFi47I+NHBH94/naAbqUG/Xu0aREry2ACnaZmXwfWyOjKc6g96YG1H2MYy/LhH3zU2EAZ04BDAmp0TsK9mv0kXxYl5wrnHPYGrkqpB9SulPwIDAQAB';

export function extensionEnvironment(name) {
  if (name === 'production') return { name, appOrigin: 'https://new.limova.ai', apiOrigin: 'https://api.new.limova.ai' };
  if (name === 'staging') return { name, appOrigin: 'https://staging.new.limova.ai', apiOrigin: 'https://api.staging.new.limova.ai' };
  throw new Error('Extension environment must be production or staging');
}

export function environmentModule(environment) {
  return `export const LIMOVA_ENVIRONMENT = ${JSON.stringify(environment.name)};\nexport const LIMOVA_APP_URL = ${JSON.stringify(environment.appOrigin)};\nexport const LIMOVA_API_URL = ${JSON.stringify(environment.apiOrigin)};\n`;
}

export function environmentManifest(source, environment) {
  const manifest = structuredClone(source);
  if (environment.name === 'staging') {
    manifest.name = 'Limova AI — Staging';
    manifest.version_name = `${manifest.version}-staging`;
    manifest.key = STAGING_EXTENSION_KEY;
    manifest.description = 'Qualification staging de Charly Deep Agent. Aucun service legacy de production.';
    manifest.host_permissions = [`${environment.apiOrigin}/*`, `${environment.appOrigin}/*`];
    manifest.content_security_policy.extension_pages = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src ${environment.apiOrigin}; media-src 'self' blob:; object-src 'none';`;
    manifest.action.default_title = 'Limova AI — Staging';
    manifest.content_scripts = manifest.content_scripts.map(script => ({ ...script, matches: [`${environment.appOrigin}/*`] }));
  }
  return manifest;
}
