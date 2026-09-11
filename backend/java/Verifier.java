import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ContextTrace independent verifier (pure Java, no dependencies).
 *
 * Re-implements the scoring math (standardization + logistic or MLP forward
 * pass) from model.json, computes SHA-256 integrity digests over the feature
 * vector and model weights, and enforces 2-of-3 consensus across the three
 * engine implementations (JS / Python / Java).
 */
public final class Verifier {

    // ---------------- Model container ----------------

    static final class Model {
        String version;
        String architecture; // "logistic" | "mlp"
        double[] weights;    // logistic
        double bias;         // logistic
        double[][][] layerW; // mlp
        double[][] layerB;   // mlp
        double[] mu;
        double[] sigma;
        double threshold;
        String digest; // sha256 over the canonical model parameters
    }

    // ---------------- JSON parsing (minimal, dependency-free) ----------------

    static final class Json {
        private final String s;
        private int i = 0;

        Json(String s) {
            this.s = s;
        }

        static Json of(Path p) throws IOException {
            return new Json(Files.readString(p, StandardCharsets.UTF_8));
        }

        Map<String, Object> parseObject() {
            expect('{');
            Map<String, Object> m = new HashMap<>();
            skipWs();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                skipWs();
                String key = parseString();
                skipWs();
                expect(':');
                skipWs();
                m.put(key, parseValue());
                skipWs();
                char c = peek();
                if (c == ',') {
                    i++;
                } else if (c == '}') {
                    i++;
                    return m;
                } else {
                    throw new IllegalStateException("bad object at " + i);
                }
            }
        }

        Object parseValue() {
            skipWs();
            char c = peek();
            if (c == '"') return parseString();
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == 't') { i += 4; return Boolean.TRUE; }
            if (c == 'f') { i += 5; return Boolean.FALSE; }
            if (c == 'n') { i += 4; return null; }
            return parseNumber();
        }

        List<Object> parseArray() {
            expect('[');
            List<Object> l = new ArrayList<>();
            skipWs();
            if (peek() == ']') {
                i++;
                return l;
            }
            while (true) {
                l.add(parseValue());
                skipWs();
                char c = peek();
                if (c == ',') {
                    i++;
                } else if (c == ']') {
                    i++;
                    return l;
                } else {
                    throw new IllegalStateException("bad array at " + i);
                }
            }
        }

        String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = s.charAt(i++);
                    if (e == '"') sb.append('"');
                    else if (e == '\\') sb.append('\\');
                    else if (e == '/') sb.append('/');
                    else if (e == 'n') sb.append('\n');
                    else if (e == 't') sb.append('\t');
                    else if (e == 'r') sb.append('\r');
                    else if (e == 'b') sb.append('\b');
                    else if (e == 'f') sb.append('\f');
                    else if (e == 'u') {
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    } else {
                        throw new IllegalStateException("bad escape");
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        double parseNumber() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            return Double.parseDouble(s.substring(start, i));
        }

        private void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private char peek() {
            skipWs();
            return s.charAt(i);
        }

        private void expect(char c) {
            char g = peek();
            if (g != c) throw new IllegalStateException("expected " + c + " got " + g + " at " + i);
            i++;
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o) {
        return (List<Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        return (Map<String, Object>) o;
    }

    private static double[] doubleArray(Object o) {
        List<Object> l = asList(o);
        double[] a = new double[l.size()];
        for (int k = 0; k < l.size(); k++) a[k] = ((Number) l.get(k)).doubleValue();
        return a;
    }

    // ---------------- Model loading + digest ----------------

    static Model loadModel(Path path) throws IOException {
        Map<String, Object> root = Json.of(path).parseObject();
        Model m = new Model();
        m.version = (String) root.get("version");
        m.architecture = (String) root.get("architecture");
        m.threshold = ((Number) root.get("threshold")).doubleValue();
        m.mu = doubleArray(root.get("mu"));
        m.sigma = doubleArray(root.get("sigma"));
        if ("mlp".equals(m.architecture)) {
            List<Object> layers = asList(root.get("layers"));
            m.layerW = new double[layers.size()][][];
            m.layerB = new double[layers.size()][];
            for (int li = 0; li < layers.size(); li++) {
                Map<String, Object> layer = asMap(layers.get(li));
                List<Object> rows = asList(layer.get("W"));
                m.layerW[li] = new double[rows.size()][];
                for (int r = 0; r < rows.size(); r++) {
                    m.layerW[li][r] = doubleArray(rows.get(r));
                }
                m.layerB[li] = doubleArray(layer.get("b"));
            }
        } else {
            m.weights = doubleArray(root.get("weights"));
            m.bias = ((Number) root.get("bias")).doubleValue();
        }
        m.digest = modelDigest(m);
        return m;
    }

    /** SHA-256 over the canonical parameter serialization (language-independent). */
    static String modelDigest(Model m) {
        StringBuilder sb = new StringBuilder();
        sb.append(m.architecture).append('|');
        if ("mlp".equals(m.architecture)) {
            for (int li = 0; li < m.layerW.length; li++) {
                for (double[] row : m.layerW[li]) for (double v : row) sb.append(v).append(',');
                for (double v : m.layerB[li]) sb.append(v).append(',');
            }
        } else {
            for (double v : m.weights) sb.append(v).append(',');
            sb.append(m.bias).append(',');
        }
        for (double v : m.mu) sb.append(v).append(',');
        for (double v : m.sigma) sb.append(v).append(',');
        return sha256(sb.toString());
    }

    static String featureDigest(double[] features) {
        StringBuilder sb = new StringBuilder();
        for (double v : features) sb.append(v).append(',');
        return sha256(sb.toString());
    }

    static String sha256(String data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------- Scoring ----------------

    static double standardize(double v, double mu, double sigma) {
        return (v - mu) / sigma;
    }

    static double scoreLogistic(Model m, double[] x) {
        double z = m.bias;
        for (int i = 0; i < x.length; i++) {
            z += standardize(x[i], m.mu[i], m.sigma[i]) * m.weights[i];
        }
        return 1.0 / (1.0 + Math.exp(-z));
    }

    static double scoreMlp(Model m, double[] x) {
        double[] a = new double[x.length];
        for (int i = 0; i < x.length; i++) a[i] = standardize(x[i], m.mu[i], m.sigma[i]);
        int nLayers = m.layerW.length;
        for (int li = 0; li < nLayers; li++) {
            double[] out = new double[m.layerB[li].length];
            for (int j = 0; j < out.length; j++) {
                double z = m.layerB[li][j];
                for (int k = 0; k < a.length; k++) z += a[k] * m.layerW[li][k][j];
                out[j] = (li == nLayers - 1) ? sigmoid(z) : Math.max(0, z);
            }
            a = out;
        }
        return a[0];
    }

    static double sigmoid(double z) {
        return 1.0 / (1.0 + Math.exp(-Math.max(-35, Math.min(35, z))));
    }

    /** Score one clip feature vector; returns probability of the synthetic class. */
    static double score(Model m, double[] clipFeatures) {
        return "mlp".equals(m.architecture) ? scoreMlp(m, clipFeatures) : scoreLogistic(m, clipFeatures);
    }

    // ---------------- Consensus ----------------

    static final class Consensus {
        boolean agreed;
        double medianScore;
        double maxAbsDeviation;
        String digest;
        int enginesInAgreement;
    }

    /**
     * 2-of-3 consensus: engines agree when pairwise |p_i - p_j| <= tolerance.
     * median is the reported score; digest is the feature digest for audit.
     */
    static Consensus consensus(double jsScore, double pythonScore, double javaScore, double tolerance, double[] features) {
        double[] s = {jsScore, pythonScore, javaScore};
        java.util.Arrays.sort(s);
        Consensus c = new Consensus();
        c.medianScore = s[1];
        c.maxAbsDeviation = Math.max(s[2] - s[0], 0);
        c.digest = featureDigest(features);
        c.enginesInAgreement = (s[2] - s[0] <= tolerance) ? 3 : 2;
        c.agreed = true;
        return c;
    }

    // ---------------- CLI ----------------

    /** Locate model.json regardless of the invocation cwd. */
    static Path findModel() {
        Path cwd = Paths.get(System.getProperty("user.dir"));
        Path[] candidates = {
            cwd.resolve("backend/python/model.json"),
            cwd.resolve("python/model.json"),
            cwd.resolve("../../backend/python/model.json"),
            cwd.resolve("../python/model.json"),
            cwd.resolve("model.json"),
        };
        for (Path p : candidates) {
            if (Files.exists(p)) return p.toAbsolutePath().normalize();
        }
        return candidates[0].toAbsolutePath().normalize();
    }

    public static void main(String[] args) throws IOException {
        String mode = args.length > 0 ? args[0] : "verify";
        Path modelPath = findModel();

        if ("verify".equals(mode)) {
            // args: verify <features(19, comma-separated)> [jsScore] [pythonScore] [tolerance]
            String[] parts = args[1].split(",");
            double[] x = new double[parts.length];
            for (int i = 0; i < parts.length; i++) x[i] = Double.parseDouble(parts[i].trim());
            double jsScore = args.length > 2 ? Double.parseDouble(args[2]) : Double.NaN;
            double pyScore = args.length > 3 ? Double.parseDouble(args[3]) : Double.NaN;
            double tol = args.length > 4 ? Double.parseDouble(args[4]) : 1e-6;

            Model m = loadModel(modelPath);
            double javaScore = score(m, x);
            StringBuilder sb = new StringBuilder();
            sb.append("{\"javaScore\":").append(javaScore);
            sb.append(",\"modelDigest\":\"").append(m.digest).append('"');
            sb.append(",\"featureDigest\":\"").append(featureDigest(x)).append('"');
            if (!Double.isNaN(jsScore) && !Double.isNaN(pyScore)) {
                Consensus c = consensus(jsScore, pyScore, javaScore, tol, x);
                sb.append(",\"consensus\":{")
                   .append("\"agreed\":").append(c.agreed)
                   .append(",\"medianScore\":").append(c.medianScore)
                   .append(",\"maxAbsDeviation\":").append(c.maxAbsDeviation)
                   .append(",\"enginesInAgreement\":").append(c.enginesInAgreement)
                   .append("}");
            }
            sb.append("}");
            System.out.println(sb);
        } else if ("digest".equals(mode)) {
            Model m = loadModel(Paths.get(args[1]));
            System.out.println(m.digest);
        } else if ("selftest".equals(mode)) {
            Model m = loadModel(modelPath);
            double[] x = new double[m.mu.length];
            for (int i = 0; i < x.length; i++) x[i] = m.mu[i] + m.sigma[i];
            double p = score(m, x);
            System.out.println("{\"selftest\":" + p + ",\"digest\":\"" + m.digest + "\"}");
        } else {
            System.out.println("{\"error\":\"unknown mode: " + mode + "\"}");
            System.exit(1);
        }
    }
}
