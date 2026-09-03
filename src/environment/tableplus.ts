/**
 * Moved to `core/service-identity`, where the "is this a database" decision
 * lives beside it. Re-exported because the banner is not the only caller any
 * more and the old path is the one people know.
 */
export { tablePlusUrl } from "../core/service-identity";
