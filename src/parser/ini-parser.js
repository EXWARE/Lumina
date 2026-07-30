const fs = require('fs');
const path = require('path');

class IniParser {
    constructor(suiteDir = '') {
        this.sections = {};
        this.variables = {};
        this.suiteDir = suiteDir;
        this.parsedFiles = new Set();
    }

    parseFile(filePath) {
        if (!fs.existsSync(filePath)) {
            console.warn(`[IniParser] File not found: ${filePath}`);
            return this.sections;
        }
        
        if (this.parsedFiles.has(filePath)) return this.sections;
        this.parsedFiles.add(filePath);
        
        let text = '';
        try {
            const content = fs.readFileSync(filePath);
            const isUTF16 = content.includes('\u0000');
            text = isUTF16 ? content.toString('utf16le') : content.toString('utf8');
        } catch (e) {
            console.error(`[IniParser] Error reading file ${filePath}:`, e);
            return this.sections;
        }

        this.parseString(text, path.dirname(filePath));
        
        // Basic variable substitution passes
        for (let pass = 0; pass < 3; pass++) {
            for (const section in this.sections) {
                for (const key in this.sections[section]) {
                    if (key === '_name') continue;
                    let val = this.sections[section][key];
                    
                    val = val.replace(/#([^#\s]+)#/g, (match, varName) => {
                        const lVarName = varName.toLowerCase();
                        if (lVarName === '@') return path.join(this.suiteDir, '@Resources').replace(/\\/g, '/');
                        return this.variables[lVarName] !== undefined ? this.variables[lVarName] : match;
                    });
                    
                    this.sections[section][key] = val;
                }
            }
        }
        
        return this.sections;
    }

    parseString(content, basePath = '') {
        const lines = content.split(/\r?\n/);
        let currentSection = null;

        for (let line of lines) {
            line = line.split(';')[0].trim();
            if (!line) continue;

            const sectionMatch = line.match(/^\[(.*)\]$/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].toLowerCase();
                if (!this.sections[currentSection]) {
                    this.sections[currentSection] = { _name: currentSection };
                }
                continue;
            }

            if (currentSection) {
                const eqIndex = line.indexOf('=');
                if (eqIndex !== -1) {
                    const key = line.substring(0, eqIndex).trim().toLowerCase();
                    const value = line.substring(eqIndex + 1).trim();
                    
                    if (key.startsWith('@include')) {
                        let incPath = value;
                        // Resolve #@# to @Resources
                        if (incPath.includes('#@#')) {
                            incPath = incPath.replace(/#@#/g, path.join(this.suiteDir, '@Resources') + path.sep);
                        } else {
                            incPath = path.join(basePath, incPath);
                        }
                        this.parseFile(incPath);
                    } else {
                        this.sections[currentSection][key] = value;
                        if (currentSection === 'variables') {
                            this.variables[key] = value;
                        }
                    }
                }
            }
        }
    }
    
    getMeters() {
        return Object.values(this.sections).filter(s => s.meter);
    }
    
    getMeasures() {
        return Object.values(this.sections).filter(s => s.measure);
    }
}

module.exports = IniParser;
