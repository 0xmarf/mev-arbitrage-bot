import { BigNumber } from "@ethersproject/bignumber";
import { CFMM } from "../cfmm/CFMM.js";
import { UtilityFunction } from "../utility/UtilityFunction.js";
import logger from '../utils/logger.js';
import { formatUnits } from '@ethersproject/units';

export interface LBFGSBOptions {
    maxIterations: number;
    tolerance: number;
    memory: number;
}

export interface OptimizationResult {
    v: BigNumber[];
    dualValue: BigNumber;
    converged: boolean;
    iterations: number;
}

interface LBFGSBMemory {
    s: BigNumber[][];  // s[i] = x_{k-i} - x_{k-i-1}
    y: BigNumber[][];  // y[i] = grad_{k-i} - grad_{k-i-1}
    rho: BigNumber[];  // rho[i] = 1 / (y[i] · s[i])
}

export class HybridOptimizer {
    private readonly cfmms: CFMM[];
    private readonly utility: UtilityFunction;
    private readonly options: LBFGSBOptions;

    constructor(
        cfmms: CFMM[],
        utility: UtilityFunction,
        options: LBFGSBOptions
    ) {
        this.cfmms = cfmms;
        this.utility = utility;
        this.options = options;
    }

    private async findActiveInterval(v: BigNumber[]): Promise<{ lower: BigNumber[]; upper: BigNumber[] }> {
        const lower = v.map(() => BigNumber.from(0));
        const upper = v.map(() => BigNumber.from('115792089237316195423570985008687907853269984665640564039457584007913129639935')); // uint256 max

        // Binary search to find active interval
        for (let i = 0; i < v.length; i++) {
            let left = BigNumber.from(0);
            let right = upper[i];

            while (right.sub(left).gt(BigNumber.from('1000000000000000'))) { // 0.001 ETH precision
                const mid = left.add(right.sub(left).div(2));
                const testV = [...v];
                testV[i] = mid;

                try {
                    const { value } = await this.dualObjective(testV);
                    if (value.gt(0)) {
                        right = mid;
                    } else {
                        left = mid;
                    }
                } catch (error) {
                    logger.error('Error in findActiveInterval:', error);
                    right = mid;
                }
            }

            upper[i] = right.mul(2); // Add some buffer
        }

        return { lower, upper };
    }

    private async dualObjective(v: BigNumber[]): Promise<{ value: BigNumber; gradient: BigNumber[] }> {
        // Initialize gradient array
        const gradient: BigNumber[] = v.map(() => BigNumber.from(0));
        let value = BigNumber.from(0);

        // Get optimal utility for these prices
        const { value: utilityValue, gradient: utilityGradient } = this.utility.U_optimal(v);
        value = value.add(utilityValue);
        for (let i = 0; i < gradient.length; i++) {
            gradient[i] = gradient[i].add(utilityGradient[i]);
        }

        // Add contribution from each CFMM
        for (const cfmm of this.cfmms) {
            try {
                const { delta, value: cfmmValue } = await cfmm.arbitrage(v);
                value = value.add(cfmmValue);
                
                // Update gradient
                for (let i = 0; i < gradient.length; i++) {
                    gradient[i] = gradient[i].add(delta[i]);
                }
            } catch (error) {
                logger.error('Error in dualObjective for CFMM:', error);
                throw error;
            }
        }

        return { value, gradient };
    }

    private async lbfgsbStep(
        v: BigNumber[],
        memory: LBFGSBMemory,
        prevGrad: BigNumber[],
        bounds: { lower: BigNumber[]; upper: BigNumber[] }
    ): Promise<{ newV: BigNumber[]; newGrad: BigNumber[]; newValue: BigNumber }> {
        // Two-loop recursion to compute search direction
        const q = [...prevGrad];
        const alpha: BigNumber[] = [];

        // First loop
        for (let i = memory.s.length - 1; i >= 0; i--) {
            if (memory.s[i] && memory.y[i]) {
                const alphaI = memory.rho[i].mul(
                    memory.s[i].reduce((sum, sij, j) => sum.add(sij.mul(q[j])), BigNumber.from(0))
                );
                alpha.push(alphaI);
                for (let j = 0; j < q.length; j++) {
                    q[j] = q[j].sub(alphaI.mul(memory.y[i][j]));
                }
            }
        }

        // Scale using last pair
        if (memory.s.length > 0 && memory.s[0] && memory.y[0]) {
            const scale = memory.s[0].reduce((sum, si, i) => 
                sum.add(si.mul(memory.y[0][i])), BigNumber.from(0)
            ).div(
                memory.y[0].reduce((sum, yi) => sum.add(yi.mul(yi)), BigNumber.from(0))
            );
            for (let i = 0; i < q.length; i++) {
                q[i] = q[i].mul(scale);
            }
        }

        // Second loop
        for (let i = 0; i < memory.s.length; i++) {
            if (memory.s[i] && memory.y[i] && alpha[memory.s.length - 1 - i]) {
                const beta = memory.rho[i].mul(
                    memory.y[i].reduce((sum, yij, j) => sum.add(yij.mul(q[j])), BigNumber.from(0))
                );
                for (let j = 0; j < q.length; j++) {
                    q[j] = q[j].add(memory.s[i][j].mul(alpha[memory.s.length - 1 - i].sub(beta)));
                }
            }
        }

        // Line search in negative gradient direction
        const direction = q.map(qi => qi.mul(-1));
        
        // Project onto bounds
        const newV = v.map((vi, i) => {
            const projected = vi.add(direction[i]);
            if (projected.lt(bounds.lower[i])) return bounds.lower[i];
            if (projected.gt(bounds.upper[i])) return bounds.upper[i];
            return projected;
        });

        // Evaluate at new point
        const { value: newValue, gradient: newGrad } = await this.dualObjective(newV);

        return { newV, newGrad, newValue };
    }

    public async optimize(initialV: BigNumber[]): Promise<OptimizationResult> {
        let v = [...initialV];
        let iteration = 0;
        let converged = false;

        // Initialize memory
        const memory: LBFGSBMemory = {
            s: [],
            y: [],
            rho: []
        };

        // Get initial gradient
        const { value, gradient: grad } = await this.dualObjective(v);
        let currentValue = value;
        let currentGrad = grad;

        // Find active bounds
        const bounds = await this.findActiveInterval(v);

        while (iteration < this.options.maxIterations && !converged) {
            try {
                // Store old values
                const oldV = [...v];
                const oldGrad = [...currentGrad];

                // Take LBFGS-B step
                const { newV, newGrad, newValue } = await this.lbfgsbStep(v, memory, currentGrad, bounds);

                // Update memory
                const s = newV.map((nv, i) => nv.sub(oldV[i]));
                const y = newGrad.map((ng, i) => ng.sub(oldGrad[i]));
                
                const ys = y.reduce((sum, yi, i) => sum.add(yi.mul(s[i])), BigNumber.from(0));
                if (ys.gt(0)) {
                    memory.s.push(s);
                    memory.y.push(y);
                    memory.rho.push(BigNumber.from(1).mul(BigNumber.from(2).pow(64)).div(ys)); // Scale to maintain precision

                    if (memory.s.length > this.options.memory) {
                        memory.s.shift();
                        memory.y.shift();
                        memory.rho.shift();
                    }
                }

                // Update current point
                v = newV;
                currentGrad = newGrad;
                currentValue = newValue;

                // Check convergence
                const gradNormSquared = currentGrad.reduce((sum, g) => sum.add(g.mul(g)), BigNumber.from(0));
                // Since we can't do exact square root with BigNumber, we'll compare the square of the tolerance
                const toleranceSquared = BigNumber.from(this.options.tolerance * 1e18).mul(BigNumber.from(this.options.tolerance * 1e18));
                converged = gradNormSquared.lt(toleranceSquared);

                iteration++;
            } catch (error) {
                logger.error('Error in optimize iteration:', error);
                throw error;
            }
        }

        return {
            v,
            dualValue: currentValue,
            converged,
            iterations: iteration
        };
    }
} 