const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const argv = yargs(hideBin(process.argv)).argv

let phase = argv?.p || argv?.phase || null;
switch (phase){
    case 1:
        require("./phases/phase-1")();
        break;
    case 2:
        require("./phases/phase-2")();
        break;
    case 3:
        require("./phases/phase-3")();
        break;
    case 4:
        require("./phases/phase-4")();
        break;
    default:
        console.log("⚠️  No phase variable provided. Use the -p or --phase flag to run other phases. ⚠️");
        break;
}
