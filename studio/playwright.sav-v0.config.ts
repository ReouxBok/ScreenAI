import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"./tests/e2e-sav-v0",timeout:60000,expect:{timeout:20000},workers:1,fullyParallel:false,retries:0,reporter:"list",outputDir:".sav-preview/e2e-results",use:{baseURL:"http://127.0.0.1:3013",headless:true,trace:"retain-on-failure",screenshot:"only-on-failure"}});
