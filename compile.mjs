import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const contractPath = 'c:\\Users\\DELL\\Downloads\\sourcepay-main\\ContentRegistry.sol';
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'ContentRegistry.sol': {
      content: source,
    },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  output.errors.forEach((err) => {
    console.error(err.formattedMessage);
  });
}

const contract = output.contracts['ContentRegistry.sol']['ContentRegistry'];
const abi = contract.abi;
const bytecode = contract.evm.bytecode.object;

console.log('ABI:');
console.log(JSON.stringify(abi, null, 2));
console.log('\nBYTECODE:');
console.log(bytecode);

fs.writeFileSync('c:\\Users\\DELL\\Downloads\\sourcepay-main\\ContentRegistry.json', JSON.stringify({ abi, bytecode }, null, 2));
console.log('\nWritten ContentRegistry.json successfully!');
